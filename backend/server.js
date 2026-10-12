require("dotenv").config();
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { Pool } = require("pg");

const app = express();
const PORT = Number(process.env.PORT || 10000);
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "https://xe-developments.github.io";
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
  origin(origin, cb) {
    if (!origin || origin === FRONTEND_ORIGIN) return cb(null, true);
    return cb(new Error("Origin not allowed by CORS"));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: "draft-7", legacyHeaders: false });

app.post("/api/webhooks/razorpay", express.raw({type:"application/json", limit:"1mb"}), async (req,res) => {
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const signature = req.get("x-razorpay-signature");
    if (!secret || !signature || !Buffer.isBuffer(req.body)) return res.status(400).send("Webhook configuration/signature missing");
    const expected = crypto.createHmac("sha256",secret).update(req.body).digest("hex");
    if (!safeEqual(expected,signature)) return res.status(400).send("Invalid webhook signature");
    const event = JSON.parse(req.body.toString("utf8"));
    const payment = event.payload?.payment?.entity;
    if ((event.event === "payment.captured" || event.event === "order.paid") && payment?.order_id && payment?.id) {
      await markOrderPaid(payment.order_id,payment.id);
    } else if (event.event === "payment.failed" && payment?.order_id) {
      await pool.query("UPDATE orders SET status='failed' WHERE razorpay_order_id=$1 AND status <> 'paid'",[payment.order_id]);
    }
    res.status(200).json({received:true});
  } catch(e) { console.error("Webhook error:",e.message); res.status(500).send("Webhook processing failed"); }
});
app.use(express.json({limit:"100kb"}));

app.get("/",(_req,res)=>res.json({service:"Xe Store API",status:"ok"}));
app.get("/health",async(_req,res)=>{
  try { await pool.query("SELECT 1"); res.json({status:"ok",database:"connected"}); }
  catch { res.status(503).json({status:"error",database:"unavailable"}); }
});
app.get("/api/products",async(_req,res)=>{
  try {
    const r=await pool.query("SELECT id,name,description,price_paise,image_url FROM products WHERE active=TRUE ORDER BY created_at DESC");
    res.json({products:r.rows.map(p=>({id:p.id,name:p.name,description:p.description,pricePaise:p.price_paise,priceRupees:p.price_paise/100,imageUrl:p.image_url}))});
  } catch(e) { console.error("Products error:",e.message); res.status(500).json({error:"Could not load products"}); }
});
app.post("/api/orders",limiter,async(req,res)=>{
  let db;
  try {
    const {customer,items}=req.body||{};
    const name=clean(customer?.name,100), email=clean(customer?.email,254).toLowerCase(), phone=clean(customer?.phone,20);
    if(!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !phone) return res.status(400).json({error:"Enter a valid name, email, and phone number."});
    if(!Array.isArray(items)||items.length<1||items.length>30) return res.status(400).json({error:"Cart is empty or contains too many items."});
    const quantities=new Map();
    for(const item of items){
      const id=clean(item?.productId,100), qty=Number(item?.quantity);
      if(!id||!Number.isInteger(qty)||qty<1||qty>20) return res.status(400).json({error:"Invalid product or quantity."});
      quantities.set(id,(quantities.get(id)||0)+qty);
    }
    const ids=[...quantities.keys()];
    const found=await pool.query("SELECT id,name,price_paise FROM products WHERE active=TRUE AND id=ANY($1::text[])",[ids]);
    if(found.rows.length!==ids.length) return res.status(400).json({error:"One or more products are unavailable. Refresh the store."});
    const byId=new Map(found.rows.map(p=>[p.id,p]));
    const orderItems=ids.map(id=>({productId:id,name:byId.get(id).name,quantity:quantities.get(id),unitPricePaise:byId.get(id).price_paise}));
    const amount=orderItems.reduce((s,i)=>s+i.unitPricePaise*i.quantity,0);
    if(!Number.isSafeInteger(amount)||amount<100) return res.status(400).json({error:"Order amount is invalid or below Razorpay's minimum."});
    if(!process.env.RAZORPAY_KEY_ID||!process.env.RAZORPAY_KEY_SECRET||process.env.RAZORPAY_KEY_ID.includes("REPLACE_ME")) return res.status(503).json({error:"Payment service is not configured yet."});
    const localId=crypto.randomUUID();
    db=await pool.connect();
    await db.query("BEGIN");
    await db.query("INSERT INTO orders (id,customer_name,customer_email,customer_phone,items,amount_paise,currency,status) VALUES ($1,$2,$3,$4,$5::jsonb,$6,'INR','created')",[localId,name,email,phone,JSON.stringify(orderItems),amount]);
    const auth=Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString("base64");
    const rr=await fetch("https://api.razorpay.com/v1/orders",{method:"POST",headers:{Authorization:`Basic ${auth}`,"Content-Type":"application/json"},body:JSON.stringify({amount,currency:"INR",receipt:localId.slice(0,40),notes:{xe_store_order_id:localId}})});
    const rp=await rr.json().catch(()=>({}));
    if(!rr.ok||!rp.id) throw new Error(`Razorpay order creation failed: ${rp.error?.description||rr.status}`);
    await db.query("UPDATE orders SET razorpay_order_id=$1 WHERE id=$2",[rp.id,localId]);
    await db.query("COMMIT");
    res.status(201).json({orderId:localId,razorpayOrderId:rp.id,amount,currency:"INR",keyId:process.env.RAZORPAY_KEY_ID,customer:{name,email,contact:phone}});
  } catch(e) {
    if(db) await db.query("ROLLBACK").catch(()=>{});
    console.error("Create order error:",e.message);
    res.status(500).json({error:"Could not create payment order. Please try again."});
  } finally { if(db) db.release(); }
});
app.post("/api/payments/verify",limiter,async(req,res)=>{
  try {
    const {razorpay_order_id,razorpay_payment_id,razorpay_signature}=req.body||{};
    if(![razorpay_order_id,razorpay_payment_id,razorpay_signature].every(v=>typeof v==="string"&&v.length>0&&v.length<300)) return res.status(400).json({error:"Payment verification details are incomplete."});
    if(!process.env.RAZORPAY_KEY_SECRET||!process.env.RAZORPAY_KEY_ID) return res.status(503).json({error:"Payment service is not configured."});
    const result=await pool.query("SELECT id,amount_paise,currency,status FROM orders WHERE razorpay_order_id=$1",[razorpay_order_id]);
    if(!result.rowCount) return res.status(404).json({error:"Order not found."});
    const order=result.rows[0];
    const expected=crypto.createHmac("sha256",process.env.RAZORPAY_KEY_SECRET).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest("hex");
    if(!safeEqual(expected,razorpay_signature)) return res.status(400).json({error:"Payment signature is invalid."});
    if(order.status==="paid") return res.json({verified:true,orderId:order.id,status:"paid"});
    const auth=Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString("base64");
    const pr=await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(razorpay_payment_id)}`,{headers:{Authorization:`Basic ${auth}`}});
    const payment=await pr.json().catch(()=>({}));
    if(!pr.ok||payment.order_id!==razorpay_order_id||payment.amount!==order.amount_paise||payment.currency!==order.currency) return res.status(400).json({error:"Payment does not match this order."});
    if(payment.status!=="captured") return res.status(409).json({error:"Payment is not captured yet. Check Razorpay's payment settings."});
    await markOrderPaid(razorpay_order_id,razorpay_payment_id);
    res.json({verified:true,orderId:order.id,status:"paid"});
  } catch(e) { console.error("Verify error:",e.message); res.status(500).json({error:"Could not verify payment. Check Razorpay before retrying."}); }
});
function clean(v,n){return typeof v==="string"?v.trim().replace(/[<>]/g,"").slice(0,n):"";}
function safeEqual(a,b){if(typeof a!=="string"||typeof b!=="string")return false;const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&crypto.timingSafeEqual(x,y);}
async function markOrderPaid(orderId,paymentId){
  await pool.query("UPDATE orders SET status='paid',razorpay_payment_id=$2,paid_at=COALESCE(paid_at,NOW()) WHERE razorpay_order_id=$1 AND (razorpay_payment_id IS NULL OR razorpay_payment_id=$2)",[orderId,paymentId]);
}
app.use((err,_req,res,_next)=>{
  if(err?.message==="Origin not allowed by CORS") return res.status(403).json({error:"Website origin not allowed."});
  console.error("Unhandled error:",err?.message); res.status(500).json({error:"Unexpected server error."});
});
const server=app.listen(PORT,()=>console.log(`Xe Store API listening on ${PORT}`));
async function shutdown(){server.close(async()=>{await pool.end();process.exit(0);});}
process.on("SIGTERM",shutdown); process.on("SIGINT",shutdown);
