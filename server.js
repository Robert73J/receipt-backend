const express = require("express");
const cors = require("cors");
const initSqlJs = require("sql.js");
const fs = require("fs");
const DB_PATH = "/data/database.sqlite";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

let db;

// Load or create DB
(async () => {
  const SQL = await initSqlJs();
  
  let filebuffer;
  
  if (fs.existsSync(DB_PATH)) {
    filebuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(filebuffer);
  } else {
    db = new SQL.Database();
    
    db.run(`
      CREATE TABLE receipts(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      receiptNo TEXT UNIQUE,
      business TEXT,
      customer TEXT,
      items TEXT,
      vat REAL,
      total REAL,
      status TEXT,
      createdAt TEXT
    )
    `);
  }
  
  console.log("Database ready");
})();

// Save receipt
app.post("/receipt", (req, res) => {
  if (!db) {
    return res.status(503).json({ message: "Database not ready" });
  }
  
  let {
    receiptNo,
    business,
    customer,
    items,
    status
  } = req.body;
  
  // ================= 4. SANITIZE INPUTS =================
  receiptNo = String(receiptNo || "").trim();
  business = String(business || "").trim();
  customer = String(customer || "").trim();
  status = status === "FINAL" ? "FINAL" : "DRAFT";
  
  let itemsArr;
  
  try {
    itemsArr = Array.isArray(items) ? items : JSON.parse(items);
  } catch (e) {
    return res.status(400).json({ message: "Invalid items format" });
  }
  
  // ================= 1. RECALCULATE VAT + TOTAL =================
  const VAT_RATE = 0.16;

  let cleanItems = [];
  let subtotal = 0;
  
  for (let item of itemsArr) {
    const qty = Number(item.qty);
    const price = Number(item.unitPrice);
    const name = String(item.item || "").trim();
    
    // 🔒 VALIDATE EACH ITEM
    if (!name || isNaN(qty) || isNaN(price) || qty <= 0 || price < 0) {
      return res.status(400).json({ message: "Invalid item data" });
    }
    
    const amount = Number((qty * price).toFixed(2));
    
    subtotal += amount;
    
    // 🔒 REBUILD ITEM (ignore frontend amount)
    cleanItems.push({
      item: name,
      qty,
      unitPrice: price,
      amount
    });
  }
  
  // ✅ FINAL ROUNDING
  subtotal = Number(subtotal.toFixed(2));
  const vat = Number((subtotal * VAT_RATE).toFixed(2));
  const total = Number((subtotal + vat).toFixed(2));
  
  // ================= 2. VALIDATION =================
  if (!receiptNo || !business || !customer) {
    return res.status(400).json({
      message: "Missing required fields"
    });
  }
  
  if (!Array.isArray(itemsArr) || itemsArr.length === 0) {
    return res.status(400).json({
      message: "No items in receipt"
    });
  }
  
  // ================= LENGTH VALIDATION =================
  const MAX_LENGTH = 200;

  const fields = [
    { value: customer, name: "Customer" },
    { value: business, name: "Business" }
  ];
  
  for (let field of fields) {
    if (field.value.length > MAX_LENGTH) {
      return res.status(400).json({
        message: `${field.name} name too long`
      });
    }
  }
  
  if (cleanItems.some(i => i.item.length > MAX_LENGTH)) {
    return res.status(400).json({
      message: "Item name too long"
    });
  }

  // ================= 3. CHECK EXISTING =================
  const stmt = db.prepare(
    "SELECT status FROM receipts WHERE receiptNo = ?"
  );
  
  stmt.bind([receiptNo]);
  
  let existingStatus = null;
  
  while (stmt.step()) {
    existingStatus = stmt.get()[0];
  }
  
  stmt.free();
  
  if (existingStatus === "FINAL") {
    return res.json({
      message: "Receipt already finalized"
    });
  }
  
  // ================= SAFE INSERT =================
  const insertStmt = db.prepare(`
  INSERT INTO receipts
  (receiptNo, business, customer, items, vat, total, status, createdAt)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(receiptNo) DO UPDATE SET
    business = excluded.business,
    customer = excluded.customer,
    items = excluded.items,
    vat = excluded.vat,
    total = excluded.total,
    status = excluded.status
`);
  
  insertStmt.run([
  receiptNo,
  business,
  customer,
  JSON.stringify(cleanItems), // ✅ use clean items
  vat,
  total,
  status,
  new Date().toISOString()
]);
  
  insertStmt.free();
  
  const data = db.export();
  fs.writeFile(DB_PATH, Buffer.from(data), (err) => {
    if (err) {
      console.error("DB save error", err);
      return res.status(500).json({ message: "Failed to save receipt" });
    }
  });
  
  res.json({
    message: "Receipt saved successfully",
    vat,
    total
  });
});


// Get receipt by number (for QR)
app.get("/receipt/:receiptNo", (req, res) => {
  if (!db) {
    return res.status(503).send("Database not ready");
  }

  const { receiptNo } = req.params;

  const stmt = db.prepare("SELECT * FROM receipts WHERE receiptNo = ?");
  stmt.bind([receiptNo]);
  
  let row = null;
  
  while (stmt.step()) {
    row = stmt.get();
  }
  
  stmt.free();
  
  if (!row) {
    return res.status(404).json({ message: "Receipt not found" });
  }

let items = [];
try {
  items = JSON.parse(row[4]);
} catch (e) {
  items = [];
}

res.send(`
<html>
<head>
  <title>Receipt ${row[1]}</title>
  <style>
    body { font-family: monospace; background:#f5f5f5; padding:20px; }
    .receipt { width:300px; margin:auto; background:#fff; padding:10px; }
    .row { display:flex; justify-content:space-between; }
    .center { text-align:center; }
    .divider { border-top:1px dashed #000; margin:6px 0; }
    .bold { font-weight:bold; }
  </style>
</head>
<body>

<div class="receipt">

  <div class="center bold">${row[2]}</div>
  <div class="center">${new Date(row[7]).toLocaleString()}</div>

  <div class="divider"></div>

  <div>Receipt: ${row[1]}</div>
  <div>Customer: ${row[3] || "-"}</div>

  <div class="divider"></div>

  ${items.map(item => `
    <div class="row">
      <span>${item.item}</span>
      <span>${item.amount.toFixed(2)}</span>
    </div>
  `).join("")}

  <div class="divider"></div>

  <div class="row">
    <span>VAT</span>
    <span>${row[5]}</span>
  </div>

  <div class="row bold">
    <span>TOTAL</span>
    <span>${row[6]}</span>
  </div>

  <div class="divider"></div>

  <div class="center">Thank You</div>

</div>

</body>
</html>
`);
});

app.get("/", (req, res) => {
  res.send(`
  <html>
  <body style="font-family:Arial;text-align:center;margin-top:50px;">
    <h2>Search Receipt</h2>
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
  </body>
  </html>
  `);
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
