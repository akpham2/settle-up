# Settle Up

Track shared costs for each gathering or trip, in any currency, and pay each other back: VietQR for VND, PayPal for everything else.

- **One link per group.** Each person adds their payment details once (a Vietnamese bank account and/or a PayPal.me username), and they're reused for every gathering.
- **Flexible splitting.** Add, edit or delete costs any time. Split equally, by shares (×2 for couples, 0.5 for kids), between only some people, or by exact amounts. Balances and who-pays-whom update live, and payments already marked paid are kept.
- **Paste instead of typing.** `Steak 2.75tr paid by Anh`, `Hotel US$600 paid by Anh for Anh, Sis` or `Chau owes Hoa 50k`: it reads them and does the splitting. People can be pasted as a list too.
- **Multi-currency.** Each gathering settles in one currency (e.g. AUD). Costs can be in VND, AUD, USD, NZD, EUR, GBP, SGD, CAD, HKD, THB, JPY or KRW and are converted at the gathering's rates. Rates come from [Exchange Rate API](https://www.exchangerate-api.com) each day, and you can edit them to match what your card charged.
- **Fewest payments.** *Directly to each other* covers each small amount with one person, so nobody makes lots of tiny transfers. *Through one person* has everyone pay one person, who then pays out the rest.
- **Pay in one tap.** VND gatherings give a VietQR code that every Vietnamese bank app (and MoMo/ZaloPay) can scan, with the amount and note filled in. Other currencies give a *Pay with PayPal* link and QR (`paypal.me/name/25.50AUD`). QR images can be shared or saved.
- No logins. It runs free on Cloudflare (Workers + Durable Objects).

## Deploy

**From GitHub (no laptop needed):** Cloudflare dashboard → Workers & Pages → Create → Import a repository → pick this repo → Deploy. Every push to `main` redeploys automatically.

**From a laptop:** Node.js 18+ and a free Cloudflare account.

```bash
npm install
npx wrangler login
npx wrangler deploy
```

There are no secrets to set.

## Using it

1. **People tab:** tap *Copy invite message* and send it to the group chat. Everyone adds their bank details (VND) and/or PayPal.me username (other currencies).
2. **New gathering:** name it, choose the settle currency, tick who's here (×2 for couples), then add costs as you go or paste them.
3. Share the gathering link. Each person picks their name and sees what they owe, with a QR or PayPal button. If you're receiving, *Copy message* sends someone a personal payment request.
4. Tick *Got it ✓* / *I've paid ✓* as money lands.

## Good to know

- **Privacy:** anyone with the group link can see and edit names and payment details. Share it only with the group. Group links are random 12-character IDs.
- **Rounding:** amounts are kept in whole đồng or cents, and leftover đồng or cents go to the largest shares, so totals always add up exactly.
- **Settle currency** is locked once a payment is marked paid.
- **Costs:** a family or friends group stays far inside Cloudflare's free tier.
- **Local testing:** `npx wrangler dev` runs everything on http://localhost:8787.

## Files

- `src/worker.js`: API, one Durable Object per group, and the exchange-rate proxy.
- `public/index.html`: the whole app (mobile-first, no build step).
- `wrangler.toml`: Cloudflare config.
