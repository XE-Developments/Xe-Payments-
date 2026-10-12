const API_BASE = "https://xe-payments.onrender.com";
const STORE_NAME = "XE Store";

const $ = (selector) => document.querySelector(selector);

const cart = {};
let products = [];

const money = (paise) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR"
  }).format(paise / 100);

const escapeHTML = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);

function toast(message) {
  const element = $("#toast");
  if (!element) return;

  element.textContent = message;
  element.classList.add("show");

  setTimeout(() => element.classList.remove("show"), 3000);
}

function getItems() {
  return Object.keys(cart)
    .map((id) => ({
      p: products.find((product) => String(product.id) === id),
      q: cart[id]
    }))
    .filter((item) => item.p && item.q > 0);
}

function subtotal() {
  return getItems().reduce(
    (total, item) => total + item.p.p * item.q,
    0
  );
}

function shippingCost(amount) {
  return amount === 0 || amount >= 99900 ? 0 : 4900;
}

function safeImage(url) {
  try {
    const parsed = new URL(url);
    return ["https:", "http:"].includes(parsed.protocol)
      ? parsed.href
      : "";
  } catch {
    return "";
  }
}

async function apiRequest(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      result.error || result.message || `Request failed (${response.status})`
    );
  }

  return result;
}

async function loadProducts() {
  const grid = $("#grid");

  if (grid) {
    grid.innerHTML = "<p>Loading products...</p>";
  }

  try {
    const result = await apiRequest("/api/products");
    const list = Array.isArray(result)
      ? result
      : result.products || [];

    products = list.map((item) => ({
      id: String(item.id),
      n: item.name,
      d: item.description || "",
      p: Number(item.price_paise ?? item.pricePaise ?? item.price),
      i: safeImage(item.image_url || item.imageUrl || "")
    })).filter((item) =>
      item.id &&
      item.n &&
      Number.isFinite(item.p) &&
      item.p >= 0
    );

    if (!products.length) {
      throw new Error("No products were returned by the server.");
    }

    renderProducts();
    drawCart();
  } catch (error) {
    console.error("Product loading failed:", error);

    if (grid) {
      grid.innerHTML =
        "<p>Products couldn't load. Please refresh the page and try again.</p>";
    }

    toast("Couldn't load products. Please try again.");
  }
}

function renderProducts() {
  const grid = $("#grid");
  if (!grid) return;

  grid.innerHTML = products.map((p) => `
    <article class="card">
      ${
        p.i
          ? `<img src="${escapeHTML(p.i)}" alt="${escapeHTML(p.n)}" loading="lazy">`
          : ""
      }
      <h3>${escapeHTML(p.n)}</h3>
      <p>${escapeHTML(p.d)}</p>
      <span class="price">${money(p.p)}</span>
      <button class="add" type="button" data-add="${escapeHTML(p.id)}">
        + Add to bag
      </button>
    </article>
  `).join("");

  grid.querySelectorAll("[data-add]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.add;
      cart[id] = (cart[id] || 0) + 1;
      drawCart();
      toast("Added to your bag");
    });
  });
}

function drawCart() {
  const selected = getItems();

  if ($("#count")) {
    $("#count").textContent = selected.reduce(
      (total, item) => total + item.q,
      0
    );
  }

  if ($("#subtotal")) {
    $("#subtotal").textContent = money(subtotal());
  }

  if ($("#items")) {
    $("#items").innerHTML = selected.length
      ? selected.map(({ p, q }) => `
          <div class="cartitem">
            ${
              p.i
                ? `<img src="${escapeHTML(p.i)}" alt="${escapeHTML(p.n)}">`
                : ""
            }
            <div>
              <b>${escapeHTML(p.n)}</b>
              <p>${money(p.p)}</p>
              <button type="button" data-q="${escapeHTML(p.id)}" data-d="-1">−</button>
              <span>${q}</span>
              <button type="button" data-q="${escapeHTML(p.id)}" data-d="1">+</button>
            </div>
            <button type="button" data-r="${escapeHTML(p.id)}" aria-label="Remove item">×</button>
          </div>
        `).join("")
      : "<p>Your bag is empty.</p>";

    $("#items").querySelectorAll("[data-q]").forEach((button) => {
      button.addEventListener("click", () => {
        const id = button.dataset.q;
        cart[id] = (cart[id] || 0) + Number(button.dataset.d);

        if (cart[id] <= 0) delete cart[id];

        drawCart();
      });
    });

    $("#items").querySelectorAll("[data-r]").forEach((button) => {
      button.addEventListener("click", () => {
        delete cart[button.dataset.r];
        drawCart();
      });
    });
  }

  const total = subtotal() + shippingCost(subtotal());

  if ($("#total")) {
    $("#total").textContent = money(total);
  }
}

function closePanels() {
  $("#shade")?.classList.add("hidden");
  $("#drawer")?.classList.remove("open");
  $("#modal")?.classList.add("hidden");
}

function openCart() {
  $("#shade")?.classList.remove("hidden");
  $("#drawer")?.classList.add("open");
}

function openCheckout() {
  if (!getItems().length) {
    toast("Your bag is empty.");
    return;
  }

  $("#shade")?.classList.remove("hidden");
  $("#drawer")?.classList.remove("open");
  $("#modal")?.classList.remove("hidden");
}

function getField(...names) {
  for (const name of names) {
    const element =
      document.querySelector(`[name="${name}"]`) ||
      document.getElementById(name);

    if (element) return String(element.value || "").trim();
  }

  return "";
}

function getCustomerDetails() {
  return {
    name: getField("name", "customer_name", "customerName"),
    phone: getField("phone", "customer_phone", "customerPhone"),
    email: getField("email", "customer_email", "customerEmail"),
    address: getField("address", "delivery_address", "deliveryAddress"),
    city: getField("city", "delivery_city", "deliveryCity"),
    state: getField("state", "delivery_state", "deliveryState"),
    pincode: getField("pincode", "pin", "delivery_pincode", "deliveryPincode")
  };
}

function validateCustomer(customer) {
  if (
    !customer.name ||
    !customer.phone ||
    !customer.email ||
    !customer.address ||
    !customer.city ||
    !customer.state ||
    !customer.pincode
  ) {
    return "Please fill in all delivery details, including your email.";
  }

  if (!/^[6-9]\d{9}$/.test(customer.phone)) {
    return "Enter a valid 10-digit Indian mobile number.";
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)) {
    return "Enter a valid email address.";
  }

  if (!/^\d{6}$/.test(customer.pincode)) {
    return "Enter a valid 6-digit PIN code.";
  }

  return "";
}

function loadRazorpay() {
  if (window.Razorpay) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.onload = resolve;
    script.onerror = () =>
      reject(new Error("Razorpay Checkout could not load. Check your internet connection."));

    document.head.appendChild(script);
  });
}

async function startPayment(customer, button) {
  const originalText = button?.textContent || "Continue";

  if (button) {
    button.disabled = true;
    button.textContent = "Preparing secure checkout...";
  }

  if ($("#message")) {
    $("#message").textContent = "Creating your order securely...";
  }

  try {
    await loadRazorpay();

    // The server calculates prices and shipping from its own product records.
    const order = await apiRequest("/api/orders", {
      method: "POST",
      body: JSON.stringify({
        customer,
        items: getItems().map(({ p, q }) => ({
          productId: p.id,
          quantity: q
        }))
      })
    });

    if (!order.keyId || !order.razorpayOrderId) {
      throw new Error("The server did not return the required Razorpay order details.");
    }

    const checkout = new window.Razorpay({
      key: order.keyId,
      amount: order.amount,
      currency: "INR",
      name: STORE_NAME,
      description: "Payment for your order",
      order_id: order.razorpayOrderId,

      prefill: {
        name: customer.name,
        email: customer.email,
        contact: customer.phone
      },

      notes: {
        internal_order_id: String(order.orderId || "")
      },

      theme: {
        color: "#111111"
      },

      modal: {
        ondismiss: () => {
          if ($("#message")) {
            $("#message").textContent =
              "Checkout closed. Your order may still be pending; check before trying again.";
          }
          if (button) {
            button.disabled = false;
            button.textContent = originalText;
          }
        }
      },

      handler: async function (paymentResponse) {
        if ($("#message")) {
          $("#message").textContent = "Verifying your payment...";
        }

        if (button) {
          button.disabled = true;
          button.textContent = "Verifying payment...";
        }

        try {
          const verification = await apiRequest("/api/payments/verify", {
            method: "POST",
            body: JSON.stringify({
              orderId: order.orderId,
              razorpay_order_id: paymentResponse.razorpay_order_id,
              razorpay_payment_id: paymentResponse.razorpay_payment_id,
              razorpay_signature: paymentResponse.razorpay_signature
            })
          });

          if (verification.verified !== true && verification.success !== true) {
            throw new Error(
              verification.message ||
              verification.error ||
              "Payment could not be verified yet."
            );
          }

          Object.keys(cart).forEach((id) => delete cart[id]);
          drawCart();
          closePanels();

          if ($("#message")) {
            $("#message").textContent =
              "Payment verified. Thank you for your order!";
          }

          toast("Payment verified successfully!");
        } catch (error) {
          console.error("Payment verification failed:", error);

          if ($("#message")) {
            $("#message").textContent =
              "We couldn't confirm the payment yet. Do not pay again immediately. Keep your payment ID and contact the store administrator.";
          }

          toast("Payment verification needs attention.");
        } finally {
          if (button) {
            button.disabled = false;
            button.textContent = originalText;
          }
        }
      }
    });

    checkout.on("payment.failed", (event) => {
      console.error("Razorpay payment failed:", event.error);

      if ($("#message")) {
        $("#message").textContent =
          "Payment failed or was cancelled. Please check the payment details and try again.";
      }

      toast("Payment was not completed.");

      if (button) {
        button.disabled = false;
        button.textContent = originalText;
      }
    });

    checkout.open();
  } catch (error) {
    console.error("Checkout error:", error);

    if ($("#message")) {
      $("#message").textContent =
        `Couldn't start checkout: ${error.message}`;
    }

    toast("Checkout couldn't start. Please try again.");

    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

$("#cartOpen")?.addEventListener("click", openCart);
$("#close")?.addEventListener("click", closePanels);
$("#shade")?.addEventListener("click", closePanels);
$("#checkout")?.addEventListener("click", openCheckout);
$("#modalClose")?.addEventListener("click", closePanels);

$("#form")?.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!getItems().length) {
    toast("Your bag is empty.");
    return;
  }

  const customer = getCustomerDetails();
  const error = validateCustomer(customer);

  if (error) {
    if ($("#message")) $("#message").textContent = error;
    toast(error);
    return;
  }

  const button = $("#form button[type='submit']");
  await startPayment(customer, button);
});

if ($("#year")) {
  $("#year").textContent = new Date().getFullYear();
}

loadProducts();
