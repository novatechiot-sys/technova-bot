# TechNova Website Receptionist

A chat bubble on the TechNova website, answered by AI 24/7 in Swahili or English. It uses TechNova's prices and rules, collects the visitor's name, location, need and phone number, and passes each lead to the **TechNova AI Office** (the Apps Script), which writes it into the Leads Tracker and emails Jackson when a human is needed. It never promises final prices or dates.

**Set up the TechNova AI Office first** (see its README). You need its Web App URL and secret here.

## Files
| File | What it is |
|---|---|
| `server.js` | The receptionist: knowledge, rules, the chat bubble, and the connection to Groq and the AI Office |
| `.env.example` | The settings it needs. Enter them on Render, never in the code |
| `package.json` | Tells the server what to install. Don't edit |

To change prices or rules, edit `COMPANY_BRAIN` at the top of `server.js` (also fill in the working hours) and redeploy.

## Deploy (about 30 minutes)
1. Put this folder in a new **private** GitHub repo, e.g. `technova-bot`.
2. Render → **New → Web Service** → pick the repo → Runtime **Node**, Build `npm install`, Start `npm start`.
3. **Environment** → add:
   - `GROQ_API_KEY`: your Groq key
   - `ALLOWED_ORIGINS`: `https://technova-m4cq.onrender.com`
   - `RELAY_URL`: the AI Office Web App URL
   - `RELAY_SECRET`: the same secret you put in the AI Office
4. Deploy, then open your bot's address (e.g. `https://technova-bot.onrender.com`). It should say *TechNova receptionist is running*.

Render's free plan sleeps when idle, so the first reply after a quiet spell can take up to a minute. An always-on instance fixes that once customers use it.

## Add the chat bubble to the website (5 minutes)
In the website project, open `index.html` (project root for Vite/React/Lovable sites) and add this just before `</body>`, using your real bot address:
```html
<script src="https://technova-bot.onrender.com/widget.js" defer></script>
```
Redeploy the website. A blue chat bubble appears bottom-right.

## Test (15 minutes)
On your phone, open the website and act like a customer: ask a price in Swahili, then English, give a name and number, and say you want to book. Check that:
- answers use your prices and never promise a final price,
- a row appears in the Leads Tracker with source "Website chat",
- an email alert arrives saying "Customer needs you".

## Built-in protection
Only your website can use the chat; 20 messages per 10 minutes per visitor and 40 per conversation; keys stay on the server.

## Limits
Conversation memory lasts 24 hours and clears on restart. It can't see photos.
