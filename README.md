# XE Store — GitHub Pages root-ready ZIP

Upload these four files to the ROOT of your `xe-store-razorpay` repository: `index.html`, `styles.css`, `app.js`, `README.md`.

## Publish
1. Open repository Settings → Pages.
2. Choose Deploy from a branch.
3. Select branch `main` and folder `/(root)`.
4. Save and wait for deployment.
5. Open https://xe-developments.github.io/xe-store-razorpay/

## Important
This ZIP is a static frontend preview. The sample catalogue and cart work in the browser. Checkout intentionally does not send or save customer details and does not process payments. GitHub Pages cannot run Node.js/Express or securely verify Razorpay payments. To accept real orders, deploy a backend and persistent database separately, then integrate Razorpay test mode and verify payments server-side.

Never upload `.env` files, Razorpay secrets, or database passwords to GitHub.
