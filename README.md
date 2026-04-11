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

- Leave **Access key** blank to create a new secure room (the app will generate a key).
- Share that generated key with trusted viewers/cameras so they can join.

If the page loads but cannot join rooms, verify the server is running and open `http://localhost:3000` (not the HTML file directly).
