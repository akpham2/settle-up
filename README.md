# Settle Up

Track shared costs for each gathering (like Splitwise) and pay each other back with VietQR.

- **One link per group of friends.** Each person adds their own bank details once, and they're reused for every gathering.
- **Costs like Splitwise.** Add, edit or delete costs any time. Split equally, by shares (×2 for couples), between only some people, or by exact amounts. Balances and who-pays-whom update live, and payments already marked paid are kept.
- **A new gathering for each dinner.** Pull the balances straight from Splitwise, upload Splitwise's CSV export, or **paste the costs** (`Steak 2.75tr paid by Anh`) and it does the splitting, so Splitwise is optional.
- **Paste a list of people** (`name, bank, account, holder`) instead of adding them one by one.
- **Two ways to settle.** *Directly to each other* covers each small amount with one person, so nobody makes lots of tiny transfers. *Through one person* has everyone pay one person, who then pays out the rest.
- **Everyone picks their name** and sees what they owe, with a VietQR that every Vietnamese bank app (and MoMo/ZaloPay) can scan. The amount and note are already filled in.
- **Mark paid**, and optionally **record the payment back into Splitwise** (organizer only).
- No logins. It runs free on Cloudflare (Workers + Durable Objects).

## Deploy (about 10 minutes, once)

You need Node.js 18+ on your laptop and a free Cloudflare account (https://dash.cloudflare.com/sign-up).

```bash
cd settle-up
npm install
npx wrangler login          # opens the browser to authorize Cloudflare
npx wrangler deploy
```

Wrangler prints your URL, e.g. `https://settle-up.<your-subdomain>.workers.dev`. Open it, create a group, add yourself, and send the group link to the chat.

### Connect Splitwise (optional, recommended)

1. Go to https://secure.splitwise.com/apps → **Register your application**. Any name and URL will do, e.g. the workers.dev URL above.
2. On the app page, copy the **API key**.
3. Store it, plus a PIN of your choice, as secrets:

```bash
npx wrangler secret put SPLITWISE_API_KEY    # paste the key
npx wrangler secret put ORGANIZER_PIN        # choose a PIN, e.g. 6 digits
```

Now **New gathering → Splitwise** lists your Splitwise groups. Pick one and it loads everyone's current VND balances. People are matched by Splitwise ID or name and created if they're new. Once a payment is marked paid, **→ Splitwise** records it as a payment in that group.

The key acts as *your* Splitwise account, which is why every Splitwise action asks for the organizer PIN. Only share the PIN with people you'd let record payments under your account.

## Using it

1. **People tab:** tap *Copy invite message* and send it to the group chat. Everyone adds their bank, account number and holder name (capitals, no accents).
2. **After a gathering:** tap *New gathering*, pick Splitwise / CSV / Type it, choose how to settle, then *Create gathering*.
3. Send the gathering link to the chat (*Copy link*). Each person picks their name and scans their QR. Or, if you're receiving, use *Copy msg* next to each person to send them a personal payment request.
4. Tick *Got it ✓* / *I've paid ✓* as money lands.

## Good to know

- **Privacy:** anyone with the group link can see and edit names and bank account numbers. Share it only in the group chat. Group links are random 12-character IDs.
- **QR codes** are generated in the browser to the NAPAS VietQR standard. The links inside messages use vietqr.io's free image service, so people can open them from Zalo without the app.
- **Amounts** are rounded to whole đồng. Any rounding difference goes to the largest balance.
- **Costs:** a friends group stays far inside Cloudflare's free tier.
- **Local testing:** `npx wrangler dev` runs everything on http://localhost:8787.

## Files

- `src/worker.js`: API, one Durable Object per group, and the Splitwise proxy.
- `public/index.html`: the whole app (mobile-first, no build step).
- `wrangler.toml`: Cloudflare config.
