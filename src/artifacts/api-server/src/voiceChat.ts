import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { logger } from "./lib/logger";
import { rooms, setIo } from "./voiceChatState";

export function setupVoiceChat(httpServer: HttpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
    transports: ["websocket", "polling"],
  });

  setIo(io);

  io.on("connection", (socket) => {
    logger.info({ socketId: socket.id }, "Socket connected");

    let currentUserId: string | null = null;
    let currentRoomId: string | null = null;

    socket.on(
      "join-room",
      ({ roomId, userId }: { roomId: string; userId: string }) => {
        if (!roomId || !userId) {
          socket.emit("error", { message: "roomId and userId are required" });
          return;
        }

        currentRoomId = roomId;
        currentUserId = userId;

        if (!rooms.has(roomId)) {
          rooms.set(roomId, { users: new Map() });
        }

        const room = rooms.get(roomId)!;

        const existingUsers = Array.from(room.users.values()).map((u) => ({
          userId: u.userId,
          socketId: u.socketId,
          position: u.position,
          speaking: u.speaking,
        }));

        room.users.set(userId, {
          socketId: socket.id,
          userId,
          roomId,
          position: { x: 0, y: 0, z: 0 },
          lookVector: { x: 0, y: 0, z: 1 },
          speaking: false,
        });

        socket.join(roomId);
        socket.emit("room-users", { users: existingUsers });
        socket.to(roomId).emit("user-joined", { userId, socketId: socket.id });

        logger.info({ roomId, userId, roomSize: room.users.size }, "User joined room");
      },
    );

    socket.on(
      "signal",
      ({ targetUserId, signal }: { targetUserId: string; signal: unknown }) => {
        if (!currentRoomId || !currentUserId) return;
        const room = rooms.get(currentRoomId);
        if (!room) return;
        const target = room.users.get(targetUserId);
        if (!target) return;
        io.to(target.socketId).emit("signal", { fromUserId: currentUserId, signal });
      },
    );

    socket.on("speaking", ({ speaking }: { speaking: boolean }) => {
      if (!currentRoomId || !currentUserId) return;
      const room = rooms.get(currentRoomId);
      if (!room) return;
      const user = room.users.get(currentUserId);
      if (user) user.speaking = speaking;
      const activeSpeakers = Array.from(room.users.values())
        .filter((u) => u.speaking)
        .map((u) => u.userId);
      io.to(currentRoomId).emit("speakers-updated", { activeSpeakers });
    });

    socket.on(
      "position",
      ({ position, lookVector }: { position: { x: number; y: number; z: number }; lookVector: { x: number; y: number; z: number } }) => {
        if (!currentRoomId || !currentUserId) return;
        const room = rooms.get(currentRoomId);
        if (!room) return;
        const user = room.users.get(currentUserId);
        if (user) {
          user.position = position;
          user.lookVector = lookVector;
        }
        socket.to(currentRoomId).emit("position-updated", { userId: currentUserId, position, lookVector });
      },
    );

    socket.on("disconnect", () => {
      logger.info({ socketId: socket.id, userId: currentUserId }, "Socket disconnected");
      if (!currentRoomId || !currentUserId) return;
      const room = rooms.get(currentRoomId);
      if (!room) return;
      room.users.delete(currentUserId);
      socket.to(currentRoomId).emit("user-left", { userId: currentUserId });
      if (room.users.size === 0) {
        rooms.delete(currentRoomId);
        logger.info({ roomId: currentRoomId }, "Room deleted (empty)");
      }
    });
  });

  logger.info("Voice chat Socket.IO initialized");
  return io;
}
