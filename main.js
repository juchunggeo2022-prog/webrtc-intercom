// Socket.io is loaded via script tag
// import { io } from "socket.io-client";

// Use relative URL for production (App Runner) or localhost:3000 for dev
// If serving static files from the same server, "/" or window.location.origin works best.
const SERVER_URL = window.location.origin;

// Fetch ICE Servers from backend (Secure TURN)
async function getIceServers() {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000); // 2 second timeout

        const response = await fetch(`${SERVER_URL}/api/get-turn-credentials`, {
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        const data = await response.json();
        console.log("Fetched ICE Servers:", data.iceServers); // Debug log
        if (data.iceServers && data.iceServers.length > 0) {
            return { iceServers: data.iceServers };
        }
    } catch (e) {
        console.error("Failed to fetch ICE servers (using default):", e);
    }
    // Fallback
    return {
        iceServers: [
            { urls: "stun:stun.l.google.com:19302" }
        ]
    };
}

// State
let socket;
let peerConnection;
let localStream;
let isConnected = false;
let isMuted = false;
let currentTargetId = null;
let connectionTimeout = null;
const TIMEOUT_DURATION = 60000; // 60 seconds

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
// Swipe to Open Logic
const swipeContainer = document.getElementById("swipe-container");
const swipeHandle = document.getElementById("swipe-handle");
const swipeBg = document.getElementById("swipe-bg");
const swipeText = document.querySelector(".swipe-text");

if (swipeHandle && swipeContainer) {
    let isDragging = false;
    let startX = 0;
    let currentX = 0;
    let maxDrag = 0;

    function startDrag(e) {
        if (!isConnected || !currentTargetId) return; // Only allow when connected
        isDragging = true;
        startX = (e.touches ? e.touches[0].clientX : e.clientX);

        // Recalculate dimensions here because they might be 0 initially if hidden
        maxDrag = swipeContainer.clientWidth - swipeHandle.clientWidth - 8; // 8px total padding

        swipeHandle.style.transition = "none";
        swipeBg.style.transition = "none";
    }

    function moveDrag(e) {
        if (!isDragging) return;
        const clientX = (e.touches ? e.touches[0].clientX : e.clientX);
        let delta = clientX - startX;

        currentX = Math.max(0, Math.min(delta, maxDrag));

        swipeHandle.style.transform = `translateX(${currentX}px)`;
        swipeBg.style.width = `${currentX + (swipeHandle.clientWidth / 2)}px`;
        swipeBg.style.opacity = Math.min(1, currentX / maxDrag);
    }

    function endDrag(e) {
        if (!isDragging) return;
        isDragging = false;

        swipeHandle.style.transition = "transform 0.3s ease";
        swipeBg.style.transition = "width 0.3s ease";

        if (currentX > maxDrag * 0.85) {
            // Success Trigger
            currentX = maxDrag;
            swipeHandle.style.transform = `translateX(${currentX}px)`;
            swipeBg.style.width = `100%`;
            triggerOpenDoor();
        } else {
            // Reset
            currentX = 0;
            swipeHandle.style.transform = `translateX(0px)`;
            swipeBg.style.width = `0%`;
        }
    }

    swipeHandle.addEventListener("mousedown", startDrag);
    swipeHandle.addEventListener("touchstart", startDrag);

    window.addEventListener("mousemove", moveDrag);
    window.addEventListener("touchmove", moveDrag);

    window.addEventListener("mouseup", endDrag);
    window.addEventListener("touchend", endDrag);
}

function triggerOpenDoor() {
    if (!isConnected || !currentTargetId) return;
    socket.emit("open-door", { target: currentTargetId });

    // Visual Feedback
    swipeContainer.classList.add("unlocked");
    const originalText = swipeText.textContent;
    swipeText.textContent = "unlocked";

    // Reset after 2 seconds
    setTimeout(() => {
        swipeContainer.classList.remove("unlocked");
        swipeText.textContent = "swipe to open";
        // Reset position
        swipeHandle.style.transform = `translateX(0px)`;
        swipeBg.style.width = `0%`;
    }, 2000);
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
            const joinUrl = `${window.location.origin}/connect?qrcode=${token}`;

            QRCode.toCanvas(qrCanvas, joinUrl, { width: 200 }, function (error) {
                if (error) console.error(error);
                console.log('QR code generated!');
            });
        }

        updateStatus(`Waiting for peer...`, true);

        // Start Timeout
        if (connectionTimeout) clearTimeout(connectionTimeout);
        connectionTimeout = setTimeout(() => {
            updateStatus("等待時間已過", false);
            const qrCanvas = document.getElementById("qrcode");

            // Optional: Blur or hide QR
            if (qrCanvas) qrCanvas.style.opacity = "0.2";

            // Redirect/Reload after 3 seconds
            setTimeout(() => {
                window.location.href = '/scan.html';
            }, 3000);
        }, TIMEOUT_DURATION);
    });

    socket.on("peer-joined", ({ role, peerId }) => {
        // Clear Timeout
        if (connectionTimeout) clearTimeout(connectionTimeout);

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

            peerConnection = await createPeerConnection(caller);
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
        const name = urlParams.get('name');
        if (name) {
            const targetUserEl = document.getElementById('target-user');
            if (targetUserEl) targetUserEl.textContent = `Calling ${name}...`;
        }

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

    peerConnection = await createPeerConnection(targetId);
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    socket.emit("offer", { target: targetId, sdp: offer });
}

async function createPeerConnection(targetId) {
    const iceConfig = await getIceServers();
    const pc = new RTCPeerConnection(iceConfig);
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
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: {
                facingMode: "user",
                width: { ideal: 640 },
                height: { ideal: 480 },
                frameRate: { ideal: 10, max: 10 }
            }
        });
        localVideo.srcObject = localStream;
        document.querySelector(".video-container").style.display = "block";
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
    disconnectBtn.style.display = "flex"; // Changed from inline-block
    muteBtn.disabled = false;
    // Note: Swipe handle logic checks isConnected internally
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
    // Swipe handle disabled via logic check
    updateStatus("Disconnected");
}

function resetUI() {
    if (selectionScreen) selectionScreen.style.display = "flex";
    if (waitingScreen) waitingScreen.style.display = "none";
    if (mainInterface) {
        mainInterface.style.display = "none";
        // Also hide the inner video container if needed, though main-interface hides it all
        const videoContainer = mainInterface.querySelector('.video-container');
        if (videoContainer) videoContainer.style.display = "none";
    }
    if (incomingCallModal) incomingCallModal.style.display = "none";
    if (tokenInput) tokenInput.value = "";
}

disconnectBtn.addEventListener("click", () => {
    socket.emit("hangup", { target: currentTargetId });
    endCall();
    resetUI();
});

const cameraBtn = document.getElementById("camera-btn");
let isVideoMuted = false;

muteBtn.addEventListener("click", () => {
    if (!localStream) return;
    isMuted = !isMuted;
    localStream.getAudioTracks().forEach(track => track.enabled = !isMuted);
    muteBtn.classList.toggle("muted", isMuted);

    // Optional: Update icon or style further if needed
    if (isMuted) {
        muteBtn.classList.remove("primary");
        muteBtn.classList.add("danger"); // Red for muted
    } else {
        muteBtn.classList.remove("danger");
        muteBtn.classList.add("primary"); // Blue for unmuted
    }
});

if (cameraBtn) {
    cameraBtn.addEventListener("click", () => {
        if (!localStream) return;
        isVideoMuted = !isVideoMuted;
        localStream.getVideoTracks().forEach(track => track.enabled = !isVideoMuted);

        // Update UI
        if (isVideoMuted) {
            cameraBtn.classList.remove("success");
            cameraBtn.classList.add("danger"); // Red for video off
            // Optional: Change icon to "Video Off"
            cameraBtn.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" height="32" viewBox="0 -960 960 960" width="32" fill="currentColor">
                    <path d="M792-168 678-282q-10 4-21 6.5t-21 2.5q-33 0-56.5-23.5T556-353q0-10 2.5-21t6.5-21l-58-58q-16 23-23.5 49t-7.5 54q0 66 47 113t113 47q28 0 54-7.5t49-23.5l58 58 13 13-13-13ZM160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h640q33 0 56.5 23.5T880-720v54l-80 80v-134H160v480h480l-80 80H160Zm320-320L190-770l56-56 580 580-56 56-290-290Zm0-240q-10-1-19.5-2t-19.5-1h-23l82 82v-79Z"/>
                </svg>
            `;
        } else {
            cameraBtn.classList.remove("danger");
            cameraBtn.classList.add("success"); // Green for video on
            // Restore "Video On" icon
            cameraBtn.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" height="32" viewBox="0 -960 960 960" width="32" fill="currentColor">
                    <path d="M480-80q-33 0-56.5-23.5T400-160q0-33 23.5-56.5T480-240q33 0 56.5 23.5T560-160q0 33-23.5 56.5T480-80Zm0-400q-33 0-56.5-23.5T400-560q0-33 23.5-56.5T480-640q33 0 56.5 23.5T560-560q0 33-23.5 56.5T480-480Zm0-400q-33 0-56.5-23.5T400-960q0-33 23.5-56.5T480-1040q33 0 56.5 23.5T560-960q0 33-23.5 56.5T480-880Z"/> 
                    <path d="M160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h640q33 0 56.5 23.5T880-720v480q0 33-23.5 56.5T800-160H160Zm0-80h640v-480H160v480Zm320-120q50 0 85-35t35-85q0-50-35-85t-85-35q-50 0-85 35t-35 85q0 50 35 85t85 35Z"/>
                </svg>
            `;
        }
    });
}

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
