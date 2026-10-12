CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_paise INTEGER NOT NULL CHECK (price_paise >= 0),
  image_url TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  razorpay_order_id TEXT UNIQUE,
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  items JSONB NOT NULL,
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  currency TEXT NOT NULL DEFAULT 'INR',
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created','paid','failed')),
  razorpay_payment_id TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS orders_created_at_idx ON orders (created_at DESC);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status);
INSERT INTO products (id,name,description,price_paise,image_url) VALUES
('demo-tshirt','Classic T-Shirt','A simple everyday T-shirt.',49900,'https://placehold.co/600x600?text=Classic+T-Shirt'),
('demo-mug','Everyday Mug','A ceramic mug for daily use.',24900,'https://placehold.co/600x600?text=Everyday+Mug'),
('demo-tote','Canvas Tote Bag','A reusable canvas tote bag.',34900,'https://placehold.co/600x600?text=Canvas+Tote')
ON CONFLICT (id) DO NOTHING;
