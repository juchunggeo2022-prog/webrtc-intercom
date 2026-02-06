// Socket.io is loaded via script tag
// import { io } from "socket.io-client";

const SERVER_URL = `https://${window.location.hostname}:3000`;
const ICE_SERVERS = {
    iceServers: [
        { urls: "stun:stun.l.google.com:19302" }
    ]
};

// State
let socket;
let peerConnection;
let localStream;
let isConnected = false;
let isMuted = false;
let currentTargetId = null;

// UI Elements
const selectionScreen = document.getElementById("selection-screen");
const waitingScreen = document.getElementById("waiting-screen");
const mainInterface = document.getElementById("main-interface");
const createBtn = document.getElementById("create-btn");
const joinBtn = document.getElementById("join-btn");
const tokenInput = document.getElementById("token-input");
const myTokenDisplay = document.getElementById("my-token");
const disconnectBtn = document.getElementById("disconnect-btn");
const muteBtn = document.getElementById("mute-btn");
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const appBody = document.body;
const localVideo = document.getElementById("local-video");
const remoteVideo = document.getElementById("remote-video");

// Modal Elements (Still kept for explicit answer if needed, or auto-answer)
// For "Token" flow, typically we want direct connection if "Join" is clicked.
// But let's keep the Answer modal for the Host to confirm? 
// User Request: "Token provided... connect... conversation". 
// Implies auto-connect or simple acceptance.
// Let's use Auto-Answer for smoother "Intercom" feel if desired, 
// OR show modal. Let's show modal for Host safety.

const incomingCallModal = document.getElementById("incoming-call-modal");
const callerNameDisplay = document.getElementById("caller-name-display");
const answerBtn = document.getElementById("answer-btn");
const declineBtn = document.getElementById("decline-btn");
const openDoorBtn = document.getElementById("open-door-btn"); // Defined

// Open Door Logic
if (openDoorBtn) {
    openDoorBtn.addEventListener("click", () => {
        if (!isConnected || !currentTargetId) return;
        socket.emit("open-door", { target: currentTargetId });

        // Visual feedback
        const originalText = openDoorBtn.textContent;
        openDoorBtn.textContent = "Opening...";
        openDoorBtn.disabled = true;
        updateStatus("Requesting to Open Door...", true);

        setTimeout(() => {
            updateStatus("Connected", true);
            openDoorBtn.textContent = originalText;
            openDoorBtn.disabled = false;
        }, 2000);
    });
}


// --- Initialization ---

function initSocket() {
    if (socket) return;
    socket = io(SERVER_URL);

    socket.on("connect", () => {
        updateStatus("Connected to Server", true);
    });

    socket.on("disconnect", () => {
        updateStatus("Disconnected", false);
    });

    socket.on("error", (msg) => {
        alert(msg);
        resetUI();
    });

    socket.on("open-door", () => {
        const originalStatus = statusText.textContent;
        updateStatus("DOOR OPENED!", true);
        alert("Visitor requested Open Door!");
        setTimeout(() => updateStatus("Connected", true), 3000);
    });

    // Session Events
    socket.on("session-created", (token) => {
        // Show Waiting Screen
        if (selectionScreen) selectionScreen.style.display = "none";
        if (waitingScreen) waitingScreen.style.display = "flex";
        if (myTokenDisplay) myTokenDisplay.textContent = token;

        // Generate QR Code
        const qrCanvas = document.getElementById("qrcode");
        if (qrCanvas) {
            // Updated to use specific IP and path
            const joinUrl = `https://10.0.0.161:3000/connect?qrcode=${token}`;

            QRCode.toCanvas(qrCanvas, joinUrl, { width: 200 }, function (error) {
                if (error) console.error(error);
                console.log('QR code generated!');
            });
        }

        updateStatus(`Waiting for peer...`);
    });

    socket.on("peer-joined", ({ role, peerId }) => {
        // Host sees this when Guest joins
        console.log("Peer joined:", peerId);
        if (waitingScreen) waitingScreen.style.display = "none";
        if (mainInterface) mainInterface.style.display = "block";

        // Host initiates call automatically (or we wait for them to click? Auto is better for "Intercom")
        startCall(peerId);
        updateStatus("Connecting to Peer...");
    });

    socket.on("session-joined", ({ role, peerId }) => {
        // Guest sees this when they successfully join
        console.log("Joined session with Host:", peerId);
        if (selectionScreen) selectionScreen.style.display = "none";
        if (mainInterface) mainInterface.style.display = "block";
        updateStatus("Waiting for Host...");
        // Guest waits for Offer
    });

    // Signaling
    socket.on("offer", async ({ sdp, caller }) => {
        console.log("Received Offer - Auto Answering");

        currentTargetId = caller;

        // Auto-Start Media
        try {
            await startMedia();
            startCallState();

            peerConnection = createPeerConnection(caller);
            await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);

            socket.emit("answer", { target: caller, sdp: answer });
        } catch (err) {
            console.error("Auto-answer failed:", err);
            alert("Failed to auto-answer call. Ensure camera permissions are allowed.");
        }
    });

    socket.on("answer", async ({ sdp }) => {
        if (peerConnection) {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
        }
    });

    socket.on("ice-candidate", async ({ candidate }) => {
        if (peerConnection) {
            await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        }
    });

    socket.on("hangup", () => {
        endCall();
        alert("Call ended by peer");
        resetUI();
    });
}

// UI Handlers
if (createBtn) {
    createBtn.addEventListener("click", () => {
        initSocket();
        socket.emit("create-session");
    });
}

// Auto-Create from QR or generate_token.html page or Connect via Link
const urlParams = new URLSearchParams(window.location.search);
const isGeneratePage = window.location.pathname.endsWith("generate_token.html");
const isConnectPage = window.location.pathname === "/connect";
const qrcodeToken = urlParams.get("qrcode");

if (urlParams.get("action") === "create" || isGeneratePage) {
    if (urlParams.get("action") === "create") {
        // Clear the param so refresh doesn't trigger again (optional, but good UX)
        window.history.replaceState({}, document.title, "/");
    }

    // Slight delay to ensure UI is ready
    setTimeout(() => {
        initSocket();
        socket.emit("create-session");
    }, 500);
} else if (isConnectPage && qrcodeToken) {
    // Auto-Join logic for /connect?qrcode=TOKEN
    setTimeout(() => {
        initSocket();
        socket.emit("join-session", qrcodeToken);
    }, 500);
}

if (joinBtn) {
    joinBtn.addEventListener("click", () => {
        const token = tokenInput.value.trim();
        if (!token) return alert("Enter Token");
        initSocket();
        socket.emit("join-session", token);
    });
}

// Modal Actions
let pendingOffer = null;

answerBtn.addEventListener("click", async () => {
    if (!pendingOffer) return;
    incomingCallModal.style.display = "none";

    const { sdp, caller } = pendingOffer;
    currentTargetId = caller;

    // Start Media
    await startMedia();
    startCallState();

    peerConnection = createPeerConnection(caller);
    await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    socket.emit("answer", { target: caller, sdp: answer });
    pendingOffer = null;
});

declineBtn.addEventListener("click", () => {
    incomingCallModal.style.display = "none";
    pendingOffer = null;
    socket.emit("hangup", { target: pendingOffer?.caller }); // Notify rejection
});


// WebRTC Logic
async function startCall(targetId) {
    currentTargetId = targetId;

    await startMedia();
    startCallState();

    peerConnection = createPeerConnection(targetId);
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    socket.emit("offer", { target: targetId, sdp: offer });
}

function createPeerConnection(targetId) {
    const pc = new RTCPeerConnection(ICE_SERVERS);
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

    pc.onicecandidate = (event) => {
        if (event.candidate) socket.emit("ice-candidate", { target: targetId, candidate: event.candidate });
    };

    pc.ontrack = (event) => {
        if (event.streams && event.streams[0]) {
            remoteVideo.srcObject = event.streams[0];
        } else {
            if (!remoteVideo.srcObject) remoteVideo.srcObject = new MediaStream();
            remoteVideo.srcObject.addTrack(event.track);
        }
    };

    pc.onconnectionstatechange = () => {
        console.log("Connection State:", pc.connectionState);
        if (pc.connectionState === 'connected') {
            updateStatus("Connected", true);
        } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
            endCall();
            resetUI();
        }
    };
    return pc;
}

// Media
async function startMedia() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: { facingMode: "user" } });
        localVideo.srcObject = localStream;
        document.querySelector(".video-container").style.display = "flex";
    } catch (err) {
        console.error(err);
        alert("Camera Access Denied");
    }
}

function stopMedia() {
    if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
        localStream = null;
    }
    localVideo.srcObject = null;
    document.querySelector(".video-container").style.display = "none";
}

// UI State Helpers
function startCallState() {
    isConnected = true;
    appBody.classList.add("is-connected");
    disconnectBtn.style.display = "inline-block";
    muteBtn.disabled = false;
    if (openDoorBtn) openDoorBtn.disabled = false;
}

function endCall() {
    isConnected = false;
    currentTargetId = null;
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    stopMedia();
    appBody.classList.remove("is-connected");
    disconnectBtn.style.display = "none";
    muteBtn.disabled = true;
    if (openDoorBtn) openDoorBtn.disabled = true;
    updateStatus("Disconnected");
}

function resetUI() {
    if (selectionScreen) selectionScreen.style.display = "flex";
    if (waitingScreen) waitingScreen.style.display = "none";
    if (mainInterface) mainInterface.style.display = "none";
    if (incomingCallModal) incomingCallModal.style.display = "none";
    if (tokenInput) tokenInput.value = "";
}

disconnectBtn.addEventListener("click", () => {
    socket.emit("hangup", { target: currentTargetId });
    endCall();
    resetUI();
});

muteBtn.addEventListener("click", () => {
    if (!localStream) return;
    isMuted = !isMuted;
    localStream.getAudioTracks().forEach(track => track.enabled = !isMuted);
    muteBtn.textContent = isMuted ? "Unmute" : "Mute";
    muteBtn.classList.toggle("muted", isMuted);
});

function updateStatus(text, green) {
    statusText.textContent = text;
    if (green) {
        statusDot.classList.add("connected");
        statusDot.classList.remove("disconnected");
    } else {
        statusDot.classList.remove("connected");
        statusDot.classList.add("disconnected");
    }
}
