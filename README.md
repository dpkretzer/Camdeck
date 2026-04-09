# KoziKamera Security

## SMS movement notifications (Twilio)

If viewers sign in with a **phone number**, Camdeck can send SMS alerts when movement is detected.
You can also use the in-app **Send test alert** button after joining as a viewer to validate delivery.
The UI now reports provider acceptance status (with Twilio SID when available). If a message is accepted but not delivered, check Twilio logs/verified recipient settings.

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

## Email movement notifications (SendGrid)

If viewers sign in with an **email address**, Camdeck can send email alerts when movement is detected.
You can use the same in-app **Send test alert** button to verify email delivery.

Set these environment variables:

- `SENDGRID_API_KEY`
- `EMAIL_FROM` (verified sender identity in SendGrid)

Example:

```bash
SENDGRID_API_KEY=SG.xxxxxxxx \
EMAIL_FROM=alerts@yourdomain.com \
npm start
```
