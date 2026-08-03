import type { Server } from "socket.io";

export interface UserInfo {
  socketId: string;
  userId: string;
  roomId: string;
  position: { x: number; y: number; z: number };
  lookVector: { x: number; y: number; z: number };
  speaking: boolean;
}

export interface Room {
  users: Map<string, UserInfo>;
}

export const rooms = new Map<string, Room>();

let _io: Server | null = null;

export function setIo(instance: Server) {
  _io = instance;
}

export function getIo(): Server | null {
  return _io;
}
