import { Router } from "express";
import { randomUUID } from "node:crypto";
import { rooms, getIo } from "../voiceChatState";

const router = Router();

const placeRooms = new Map<string, string>();

// Create or retrieve a room ID for a Roblox place+job session
router.post("/rooms", (req, res) => {
  const { placeId, jobId } = req.body as { placeId?: string; jobId?: string };

  if (!placeId) {
    res.status(400).json({ error: "placeId is required" });
    return;
  }

  const key = jobId && jobId.length > 0 ? `${placeId}-${jobId}` : placeId;

  if (!placeRooms.has(key)) {
    const roomId =
      jobId && jobId.length > 0
        ? `${placeId}-${jobId.slice(0, 8)}`
        : `${placeId}-${randomUUID().slice(0, 8)}`;
    placeRooms.set(key, roomId);
  }

  res.json({ roomId: placeRooms.get(key) });
});

// Get connected users + active speakers for a room (polled by Roblox server)
router.get("/rooms/:roomId/status", (req, res) => {
  const { roomId } = req.params;
  const room = rooms.get(roomId);

  if (!room) {
    res.json({ users: [], speakers: [] });
    return;
  }

  const users = Array.from(room.users.keys());
  const speakers = Array.from(room.users.values())
    .filter((u) => u.speaking)
    .map((u) => u.userId);

  res.json({ users, speakers });
});

// Accept position update from Roblox server and forward to web clients
router.post("/position", (req, res) => {
  const { userId, roomId, position, look } = req.body as {
    userId?: string;
    roomId?: string;
    position?: { x: number; y: number; z: number };
    look?: { x: number; y: number; z: number };
  };

  if (!userId || !roomId || !position) {
    res.status(400).json({ error: "userId, roomId and position are required" });
    return;
  }

  const room = rooms.get(roomId);
  if (room) {
    const user = room.users.get(userId);
    if (user) {
      user.position = position;
      if (look) user.lookVector = look;
    }
  }

  const io = getIo();
  if (io && look) {
    io.to(roomId).emit("position-updated", {
      userId,
      position,
      lookVector: look,
    });
  }

  res.json({ ok: true });
});

export default router;
