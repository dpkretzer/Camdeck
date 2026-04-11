# KoziKamera Security

Simple multi-camera viewer built with:

- Express
- Socket.IO
- WebRTC

Run locally:

```bash
npm install
npm start
```

Room access:

- Enter your own room number (for example `FRONTDOOR`) to create a protected room.
- The app returns a secure room code in the form `ROOMNUMBER:k_<secret>`.
- Share that full room code with trusted viewers/cameras so they can join.

If the page loads but cannot join rooms, verify the server is running and open `http://localhost:3000` (not the HTML file directly).
