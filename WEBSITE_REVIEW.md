# Camdeck Website Review (April 2026)

## What Works Well
- Clear 3-step flow: room entry → role selection → live view.
- Lightweight architecture (Express + Socket.IO + native WebRTC) keeps latency low and deployment simple.
- Mobile-friendly defaults (`playsinline`, responsive video sizing).
- Reasonable signaling lifecycle with join/leave cleanup for camera and viewer sockets.

## Highest-Impact Updates (Priority Order)

### 1) Add Real Room Security
**Why:** The UI says "secure", but rooms are guessable numeric IDs and there is no authentication/authorization.

**Recommendations:**
- Replace room number-only access with invite links containing signed, expiring tokens.
- Add optional PIN/passphrase per room.
- Add server-side rate limiting for join attempts.
- Add audit events (join/leave/fail) for room owner visibility.

### 2) Improve Connection Reliability
**Why:** Client currently uses only public STUN servers. Many users behind symmetric NAT/firewalls will fail without TURN relay.

**Recommendations:**
- Add TURN (coturn or managed provider) and serve ICE config from backend.
- Surface connection state in UI (`connecting`, `reconnecting`, `failed`).
- Add automatic renegotiation/retry on network transitions.

### 3) Add Core Viewer Experience
**Why:** Multi-camera grid is functional but lacks context and controls.

**Recommendations:**
- Camera naming (e.g., "Front Door", "Warehouse Aisle 3").
- Camera status badges (online/offline/poor connection).
- Grid layout controls (auto, 2x2, focus mode).
- Fullscreen per camera and quick mute/unmute controls.

### 4) Add Session Persistence + Recovery
**Why:** Reloads currently reset flow and can drop users out of the room.

**Recommendations:**
- Persist room + role selection in session/local storage.
- Add reconnect logic with "Rejoin last room" CTA.
- Show "camera disconnected" placeholders with retry actions.

### 5) Increase UX Quality and Accessibility
**Why:** Core flow is simple, but production apps need inclusive and guided UX.

**Recommendations:**
- Add visible loading states on connect/start actions.
- Improve empty states (no active cameras yet).
- Add labels/ARIA and keyboard focus styling.
- Add concise error copy for permissions, network, invalid token, and media device issues.

## New Feature Ideas (Roadmap)

### Phase 1: Operational Essentials
- Snapshot capture from viewer.
- Session timeline with camera join/leave markers.
- Role-specific permissions (owner/operator/view-only).

### Phase 2: Team & Monitoring
- Push/browser notifications for camera offline/reconnect.
- Watchlist rooms and favorites.
- Multi-room dashboard with mini live previews.

### Phase 3: Intelligence & Integrations
- Motion detection and event clips.
- Cloud recording with retention policy.
- Webhooks/API for external systems (Slack, incident tooling).

## Suggested Implementation Sequence
1. Security foundations (tokenized room access + rate limiting).
2. TURN + connection state instrumentation.
3. Camera metadata and viewer controls.
4. Reconnect/session persistence.
5. Notifications, recording, analytics.

## Success Metrics to Track
- Room join success rate.
- Time-to-first-frame for viewer.
- Reconnect success after network interruption.
- Viewer session duration.
- Camera uptime and drop frequency.

## Quick Wins (Can be shipped fast)
- Add camera names and room invite links.
- Add "No cameras online" empty state.
- Add reconnect button + last room persistence.
- Add connection badges and better status text.
