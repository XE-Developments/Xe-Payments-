# Xe Store API — PostgreSQL + Razorpay

This backend starter is prepared for your GitHub Pages store. It has not been deployed or tested against your personal Supabase/Razorpay accounts yet. Start with Razorpay Test Mode.

## A. Create the database schema
In Supabase open **SQL Editor → New query**. Paste and run all of `schema.sql`. It creates `products` and `orders`, plus three sample products.

## B. Deploy on Render
1. Upload the contents of this ZIP's `backend` folder into a folder named `backend` in the root of your existing GitHub repository. The repository should show `backend/package.json`, `backend/server.js`, and `backend/schema.sql`.
2. Render → New → Web Service → select your GitHub repository.
3. Branch: `main`; Root Directory: `backend`; Runtime: Node.
4. Build Command: `npm install`; Start Command: `npm start`.
5. Add the environment variables below in Render's Environment section, then deploy.

Required Render environment variables:
- `DATABASE_URL`: Supabase PostgreSQL URI from the Supabase Connect panel.
- `FRONTEND_ORIGIN`: `https://xe-developments.github.io`
- `RAZORPAY_KEY_ID`: Razorpay Test Mode key ID
- `RAZORPAY_KEY_SECRET`: Razorpay Test Mode secret
- `RAZORPAY_WEBHOOK_SECRET`: webhook secret created in Razorpay
- `NODE_ENV`: `production`

Do not commit any actual secrets to GitHub. Never put the database URI, Razorpay secret, or webhook secret in frontend files. Use the connection URI Supabase recommends for your deployment; if direct DB connections fail, follow Supabase's pooler/connection guidance.

## C. Verify
Visit `https://YOUR-SERVICE.onrender.com/health`. Expected JSON: `{"status":"ok","database":"connected"}`.
Visit `https://YOUR-SERVICE.onrender.com/api/products`. It should return a products array.

## D. API contract
- `GET /api/products`
- `POST /api/orders` body:
  `{"customer":{"name":"Test","email":"test@example.com","phone":"9000000000"},"items":[{"productId":"demo-mug","quantity":1}]}`
- `POST /api/payments/verify` body fields: `razorpay_order_id`, `razorpay_payment_id`, `razorpay_signature`
- Webhook URL: `https://YOUR-SERVICE.onrender.com/api/webhooks/razorpay`

Configure Razorpay webhooks for `payment.captured`, `payment.failed`, and `order.paid` where available. Use the same webhook secret in Render.

## E. Frontend still needs integration
Your current `app.js` is a demo. It must be updated to fetch products from this API and open Razorpay Checkout, then send the checkout response to `/api/payments/verify`. See `../frontend-integration/README.md`. Do not show a success message until the API confirms `{verified:true,status:"paid"}`.
