const express = require("express");
const cors = require("cors");
const app = express();
const pool = require("./db");

(async () => {
  try {
    await pool.query(`
      ALTER TABLE receipts
      ADD COLUMN IF NOT EXISTS logo TEXT;
    `);
    
    await pool.query(`
      ALTER TABLE receipts
      ADD COLUMN IF NOT EXISTS phone TEXT;
    `);
    
    await pool.query(`
      ALTER TABLE receipts
      ADD COLUMN IF NOT EXISTS address TEXT;
    `);
    
    console.log("✅ New columns added");
  } catch (err) {
    console.error(err);
  }
})();

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// Save receipt
app.post("/receipt", async (req, res) => {
  try {
    let {
  receiptNo,
  business,
  customer,
  logo,
  phone,
  address,
  items,
  status
} = req.body;
    
    receiptNo = String(receiptNo || "").trim();
    business = String(business || "").trim();
    customer = String(customer || "").trim();
    logo = String(logo || "").trim();
    phone = String(phone || "").trim();
    address = String(address || "").trim();
    status = status === "FINAL" ? "FINAL" : "DRAFT";
    
    if (!receiptNo || !business || !customer || !Array.isArray(items)) {
      return res.status(400).json({ message: "Invalid data" });
    }
    
    const VAT_RATE = 0.16;
    
    let subtotal = 0;
    
    const cleanItems = items.map(i => {
      const qty = Number(i.qty);
      const price = Number(i.unitPrice);
      
      const amount = qty * price;
      subtotal += amount;
      
      return {
        item: i.item,
        qty,
        unitPrice: price,
        amount
      };
    });
    
    const vat = +(subtotal * VAT_RATE).toFixed(2);
    const total = +(subtotal + vat).toFixed(2);
    
    console.log("items =", items);
    console.log("cleanItems =", cleanItems);
    console.log("json =", JSON.stringify(cleanItems));
    
    await pool.query(
  `INSERT INTO receipts
  (receiptno, business, customer, logo, phone, address, items, vat, total, status, createdAt)
  VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
  ON CONFLICT (receiptno)
  DO UPDATE SET
    business = EXCLUDED.business,
      customer = EXCLUDED.customer,
      logo = EXCLUDED.logo,
      phone = EXCLUDED.phone,
      address = EXCLUDED.address,
      items = EXCLUDED.items,
      vat = EXCLUDED.vat,
      total = EXCLUDED.total,
      status = EXCLUDED.status`,
  [
    receiptNo,
    business,
    customer,
    logo,
    phone,
    address,
    JSON.stringify(cleanItems),  
    vat,
    total,
    status
  ]
);

    res.json({ vat, total });
    
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// Get receipt by number (for QR)
app.get("/receipt/:receiptNo", async (req, res) => {
  try {
    const { receiptNo } = req.params;
    
    const result = await pool.query(
      "SELECT * FROM receipts WHERE receiptno = $1",
      [receiptNo]
    );

    if (result.rows.length === 0) {
      return res.status(404).send("Receipt not found");
    }
    
    const row = result.rows[0];
    let items = [];

    try {
      items = typeof row.items === "string" ?
        JSON.parse(row.items) :
        row.items;
    } catch {
      items = [];
    }
    
    res.send(`
      <html>
      <body style="font-family: monospace; padding:20px;">
        <h3>${row.business}</h3>
        <p>Receipt: ${row.receiptno}</p>
        <p>Customer: ${row.customer}</p>

        <hr/>

        ${items.map(i => `
          <div>${i.item} - ${i.amount}</div>
        `).join("")}

        <hr/>
        <p>VAT: ${row.vat}</p>
        <p><b>TOTAL: ${row.total}</b></p>
      </body>
      </html>
    `);
    
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading receipt");
  }
});

app.get("/", (req, res) => {
  res.send(`
    <h3>Receipt API is running ✅</h3>
    <form onsubmit="go(event)">
      <input id="r" placeholder="Enter Receipt No" required>
      <button>Search</button>
    </form>

    <script>
      function go(e){
        e.preventDefault();
        const val = document.getElementById("r").value;
        window.location.href = "/receipt/" + val;
      }
    </script>
  `);
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
