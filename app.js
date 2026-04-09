// Updated functionality for connecting to a room
connectRoomBtn.addEventListener('click', function() {
    const roomId = document.getElementById('roomIdInput').value;
    if (validateRoomId(roomId)) {
        localStorage.setItem('connectedRoom', roomId);
        updateUIWithConnectedRoom(roomId);
        switchToRoleScreen();
    } else {
        alert('Invalid Room ID.');
    }
});

function validateRoomId(roomId) {
    // Validate the room ID (this is just a placeholder, implement your validation logic)
    return roomId && roomId.length > 0;
}

function updateUIWithConnectedRoom(roomId) {
    // Update the UI to reflect the connected room
    document.getElementById('connectedRoomLabel').innerText = `Connected to Room: ${roomId}`;
}

function switchToRoleScreen() {
    // Logic to switch from home screen to role screen
    // For example:  hideHomeScreen(); showRoleScreen();
    hideHomeScreen();
    document.getElementById('roleScreen').style.display = 'block';
    document.getElementById('homeScreen').style.display = 'none';
}