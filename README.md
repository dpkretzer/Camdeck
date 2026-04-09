# Camdeck

## SMS movement notifications (Twilio)

If viewers sign in with a **phone number**, Camdeck can send SMS alerts when movement is detected.

Set the following environment variables before starting the server:

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_FROM_NUMBER` (must be a Twilio number in E.164 format, for example `+15551234567`)

Example:

```bash
TWILIO_ACCOUNT_SID=ACxxxxxxxx \
TWILIO_AUTH_TOKEN=xxxxxxxx \
TWILIO_FROM_NUMBER=+15551234567 \
npm start
```
