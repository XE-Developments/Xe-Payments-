require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { Pool } = require("pg");

const app = express();
const PORT = Number(process.env.PORT || 10000);

const FRONTEND_ORIGIN =
  process.env.FRONTEND_ORIGIN ||
  "https://xe-developments.github.io";

if (!process.env.DATABASE_URL) {
  console.error("Missing DATABASE_URL environment variable.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

app.disable("x-powered-by");
app.use(helmet());

app.use(cors({
  origin(origin, callback) {
    if (!origin || origin === FRONTEND_ORIGIN) {
      return callback(null, true);
    }
    return callback(new Error("Origin not allowed by CORS"));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false
});

// Verify Razorpay webhook signatures using the raw request body.
app.post(
  "/api/webhooks/razorpay",
  express.raw({ type: "application/json", limit: "1mb" }),
  async (req, res) => {
    try {
      const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
      const signature = req.get("x-razorpay-signature");

      if (!secret || !signature || !Buffer.isBuffer(req.body)) {
        return res.status(400).send("Webhook configuration/signature missing");
      }

      const expected = crypto
        .createHmac("sha256", secret)
        .update(req.body)
        .digest("hex");

      if (!safeEqual(expected, signature)) {
        return res.status(400).send("Invalid webhook signature");
      }

      const event = JSON.parse(req.body.toString("utf8"));
      const payment = event.payload?.payment?.entity;

      if (
        (event.event === "payment.captured" ||
          event.event === "order.paid") &&
        payment?.order_id &&
        payment?.id
      ) {
        await markOrderPaid(payment.order_id, payment.id);
      } else if (
        event.event === "payment.failed" &&
        payment?.order_id
      ) {
        await pool.query(
          `UPDATE orders
           SET status = 'failed'
           WHERE razorpay_order_id = $1
             AND status <> 'paid'`,
          [payment.order_id]
        );
      }

      return res.status(200).json({ received: true });
    } catch (error) {
      console.error("Webhook error:", error.message);
      return res.status(500).send("Webhook processing failed");
    }
  }
);

// Parse normal JSON requests after the raw-body webhook route.
app.use(express.json({ limit: "100kb" }));

app.get("/", (_req, res) => {
  res.json({ service: "Xe Store API", status: "ok" });
});

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", database: "connected" });
  } catch (error) {
    console.error("Database health error:", error.message);
    res.status(503).json({
      status: "error",
      database: "unavailable"
    });
  }
});

// Return active products from PostgreSQL.
app.get("/api/products", async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, description, price_paise, image_url
       FROM products
       WHERE active = TRUE
       ORDER BY created_at DESC`
    );

    res.json({
      products: result.rows.map(product => ({
        id: product.id,
        name: product.name,
        description: product.description,
        pricePaise: product.price_paise,
        priceRupees: product.price_paise / 100,
        imageUrl: product.image_url
      }))
    });
  } catch (error) {
    console.error("Products error:", error.message);
    res.status(500).json({
      error: "Could not load products"
    });
  }
});

// Create a database order and its matching Razorpay order.
app.post("/api/orders", limiter, async (req, res) => {
  let db;

  try {
    const { customer, items } = req.body || {};

    const name = clean(customer?.name, 100);
    const email = clean(customer?.email, 254).toLowerCase();
    const phone = clean(customer?.phone, 10);
    const address = clean(customer?.address, 300);
    const city = clean(customer?.city, 100);
    const state = clean(customer?.state, 100);
    const pincode = clean(customer?.pincode, 6);

    if (
      !name ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      !/^[6-9][0-9]{9}$/.test(phone) ||
      !address ||
      !city ||
      !state ||
      !/^[0-9]{6}$/.test(pincode)
    ) {
      return res.status(400).json({
        error: "Enter valid contact and delivery details."
      });
    }

    if (
      !Array.isArray(items) ||
      items.length < 1 ||
      items.length > 30
    ) {
      return res.status(400).json({
        error: "Cart is empty or contains too many items."
      });
    }

    // Validate product IDs and quantities.
    const quantities = new Map();

    for (const item of items) {
      const productId = clean(item?.productId, 100);
      const quantity = Number(item?.quantity);

      if (
        !productId ||
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        quantity > 20
      ) {
        return res.status(400).json({
          error: "Invalid product or quantity."
        });
      }

      quantities.set(
        productId,
        (quantities.get(productId) || 0) + quantity
      );

      if (quantities.get(productId) > 20) {
        return res.status(400).json({
          error: "Maximum quantity per product is 20."
        });
      }
    }

    const productIds = [...quantities.keys()];

    // Always get prices from the database, never from the browser.
    const result = await pool.query(
      `SELECT id, name, price_paise
       FROM products
       WHERE active = TRUE
         AND id = ANY($1::text[])`,
      [productIds]
    );

    if (result.rows.length !== productIds.length) {
      return res.status(400).json({
        error: "One or more products are unavailable. Refresh the store."
      });
    }

    const productsById = new Map(
      result.rows.map(product => [product.id, product])
    );

    const orderItems = productIds.map(id => ({
      productId: id,
      name: productsById.get(id).name,
      quantity: quantities.get(id),
      unitPricePaise: Number(productsById.get(id).price_paise)
    }));

    const subtotal = orderItems.reduce(
      (sum, item) =>
        sum + item.unitPricePaise * item.quantity,
      0
    );

    // ₹49 shipping below ₹999; free shipping at ₹999 or above.
    const shipping = subtotal >= 99900 ? 0 : 4900;
    const amount = subtotal + shipping;

    if (
      !Number.isSafeInteger(amount) ||
      amount < 100 ||
      amount > 100000000
    ) {
      return res.status(400).json({
        error: "Order amount is invalid."
      });
    }

    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;

    if (
      !keyId ||
      !keySecret ||
      keyId.includes("REPLACE_ME")
    ) {
      return res.status(503).json({
        error: "Payment service is not configured yet."
      });
    }

    const localId = crypto.randomUUID();

    db = await pool.connect();
    await db.query("BEGIN");

    await db.query(
      `INSERT INTO orders (
        id,
        customer_name,
        customer_email,
        customer_phone,
        delivery_address,
        delivery_city,
        delivery_state,
        delivery_pincode,
        items,
        amount_paise,
        currency,
        status
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8,
        $9::jsonb, $10, 'INR', 'created'
      )`,
      [
        localId,
        name,
        email,
        phone,
        address,
        city,
        state,
        pincode,
        JSON.stringify(orderItems),
        amount
      ]
    );

    const auth = Buffer.from(
      `${keyId}:${keySecret}`
    ).toString("base64");

    const razorpayResponse = await fetch(
      "https://api.razorpay.com/v1/orders",
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          amount,
          currency: "INR",
          receipt: localId.slice(0, 40),
          notes: { xe_store_order_id: localId }
        })
      }
    );

    const razorpayOrder = await razorpayResponse
      .json()
      .catch(() => ({}));

    if (!razorpayResponse.ok || !razorpayOrder.id) {
      throw new Error(
        `Razorpay order creation failed: ${
          razorpayOrder.error?.description ||
          razorpayResponse.status
        }`
      );
    }

    await db.query(
      `UPDATE orders
       SET razorpay_order_id = $1
       WHERE id = $2`,
      [razorpayOrder.id, localId]
    );

    await db.query("COMMIT");

    return res.status(201).json({
      orderId: localId,
      razorpayOrderId: razorpayOrder.id,
      keyId,
      subtotal,
      shipping,
      amount,
      currency: "INR",
      customer: {
        name,
        email,
        contact: phone
      }
    });
  } catch (error) {
    if (db) {
      await db.query("ROLLBACK").catch(() => {});
    }

    console.error("Create order error:", error.message);

    return res.status(500).json({
      error: "Could not create payment order. Please try again."
    });
  } finally {
    if (db) db.release();
  }
});

// Verify the signature and confirm the payment with Razorpay.
app.post("/api/payments/verify", limiter, async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature
    } = req.body || {};

    if (
      ![
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature
      ].every(
        value =>
          typeof value === "string" &&
          value.length > 0 &&
          value.length < 300
      )
    ) {
      return res.status(400).json({
        error: "Payment verification details are incomplete."
      });
    }

    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;

    if (!keyId || !keySecret) {
      return res.status(503).json({
        error: "Payment service is not configured."
      });
    }

    const result = await pool.query(
      `SELECT id, amount_paise, currency, status
       FROM orders
       WHERE razorpay_order_id = $1`,
      [razorpay_order_id]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: "Order not found."
      });
    }

    const order = result.rows[0];

    const expected = crypto
      .createHmac("sha256", keySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (!safeEqual(expected, razorpay_signature)) {
      return res.status(400).json({
        error: "Payment signature is invalid."
      });
    }

    if (order.status === "paid") {
      return res.json({
        verified: true,
        orderId: order.id,
        status: "paid"
      });
    }

    const auth = Buffer.from(
      `${keyId}:${keySecret}`
    ).toString("base64");

    const paymentResponse = await fetch(
      `https://api.razorpay.com/v1/payments/${encodeURIComponent(
        razorpay_payment_id
      )}`,
      {
        headers: {
          Authorization: `Basic ${auth}`
        }
      }
    );

    const payment = await paymentResponse
      .json()
      .catch(() => ({}));

    if (
      !paymentResponse.ok ||
      payment.order_id !== razorpay_order_id ||
      payment.amount !== Number(order.amount_paise) ||
      payment.currency !== order.currency
    ) {
      return res.status(400).json({
        error: "Payment does not match this order."
      });
    }

    if (payment.status !== "captured") {
      return res.status(409).json({
        error: "Payment is not captured yet. Check Razorpay payment settings."
      });
    }

    await markOrderPaid(
      razorpay_order_id,
      razorpay_payment_id
    );

    return res.json({
      verified: true,
      orderId: order.id,
      status: "paid"
    });
  } catch (error) {
    console.error("Verify error:", error.message);

    return res.status(500).json({
      error: "Could not verify payment. Check Razorpay before retrying."
    });
  }
});

function clean(value, maxLength) {
  return typeof value === "string"
    ? value.trim().replace(/[<>]/g, "").slice(0, maxLength)
    : "";
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }

  const first = Buffer.from(a);
  const second = Buffer.from(b);

  return (
    first.length === second.length &&
    crypto.timingSafeEqual(first, second)
  );
}

async function markOrderPaid(orderId, paymentId) {
  await pool.query(
    `UPDATE orders
     SET status = 'paid',
         razorpay_payment_id = $2,
         paid_at = COALESCE(paid_at, NOW())
     WHERE razorpay_order_id = $1
       AND (
         razorpay_payment_id IS NULL
         OR razorpay_payment_id = $2
       )`,
    [orderId, paymentId]
  );
}

app.use((error, _req, res, _next) => {
  if (error?.message === "Origin not allowed by CORS") {
    return res.status(403).json({
      error: "Website origin not allowed."
    });
  }

  console.error("Unhandled error:", error?.message);

  return res.status(500).json({
    error: "Unexpected server error."
  });
});

const server = app.listen(PORT, () => {
  console.log(`Xe Store API listening on ${PORT}`);
});

async function shutdown() {
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
