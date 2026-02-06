import express from "express";
import { createServer } from "https"; // Use HTTPS
import { readFileSync } from "fs"; // Read certs
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

// Load SSL Certs
const options = {
  key: readFileSync("key.pem"),
  cert: readFileSync("cert.pem")
};

const server = createServer(options, app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static("."));

// Session Store
// Key: Token (String)
// Value: { host: socketId, guest: socketId }
const sessions = new Map();

function generateToken() {
  return Math.floor(1000 + Math.random() * 9000).toString(); // 4 digit token
}

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // 1. Create Session (Host)
  socket.on("create-session", () => {
    const token = generateToken();
    sessions.set(token, { host: socket.id, guest: null });
    socket.emit("session-created", token);
    console.log(`Session created: ${token} by ${socket.id}`);
  });

  // 2. Join Session (Guest)
  socket.on("join-session", (token) => {
    const session = sessions.get(token);
    if (session) {
      if (session.guest) {
        socket.emit("error", "Session is full");
        return;
      }
      session.guest = socket.id;

      // Notify Guest they joined
      socket.emit("session-joined", { role: 'guest', peerId: session.host });

      // Notify Host that Guest joined
      io.to(session.host).emit("peer-joined", { role: 'host', peerId: socket.id });

      console.log(`User ${socket.id} joined session ${token}`);
    } else {
      socket.emit("error", "Invalid Token");
    }
  });

  // --- Signaling (Forwarding) ---

  socket.on("offer", (payload) => {
    // payload: { target, sdp }
    io.to(payload.target).emit("offer", {
      sdp: payload.sdp,
      caller: socket.id
    });
  });

  socket.on("answer", (payload) => {
    io.to(payload.target).emit("answer", {
      sdp: payload.sdp,
      responder: socket.id
    });
  });

  socket.on("ice-candidate", (payload) => {
    io.to(payload.target).emit("ice-candidate", {
      candidate: payload.candidate,
      sender: socket.id
    });
  });

  socket.on("hangup", (payload) => {
    if (payload.target) {
      io.to(payload.target).emit("hangup", { sender: socket.id });
    }
  });

  socket.on("open-door", (payload) => {
    if (payload.target) {
      io.to(payload.target).emit("open-door", { sender: socket.id });
    }
  });

  // --- Disconnect ---
  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
    // Find and cleanup sessions
    for (const [token, session] of sessions.entries()) {
      if (session.host === socket.id || session.guest === socket.id) {
        const peerId = session.host === socket.id ? session.guest : session.host;
        if (peerId) {
          io.to(peerId).emit("hangup", { sender: socket.id }); // Notify peer
          io.to(peerId).emit("peer-disconnected");
        }
        sessions.delete(token);
        console.log(`Session ${token} destroyed`);
      }
    }
  });
});

const PORT = 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on https://0.0.0.0:${PORT}`);
});
