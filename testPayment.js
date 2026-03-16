// testPayment.js
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const BASE_URL = "http://localhost:5000/api/payments";

async function testPaymentFlow() {
  try {
    console.log("🚀 Starting payment test...");

    // 1️⃣ Create a payment request
    const paymentRequest = {
      schoolId: 1,
      parentId: 1,
      studentId: 1,
      amount: 50000,
      description: "Termly tuition fee",
    };

    console.log("📌 Sending payment request to server...");
    
    // Add a 10-second timeout so we don't wait forever
    const createResp = await axios.post(`${BASE_URL}/request`, paymentRequest, {
      timeout: 10000
    });

    console.log("✅ Payment created:", createResp.data);

    const paymentId = createResp.data.payment.id;

    // 2️⃣ Upload a receipt image
    const receiptPath = path.join(__dirname, "sample-receipt.jpg");
    if (!fs.existsSync(receiptPath)) {
      console.log("⚠️ Please add a sample file named 'sample-receipt.jpg' in project root");
      return;
    }

    // Use FormData correctly
    const FormData = require('form-data');
    const formData = new FormData();
    formData.append("receipt", fs.createReadStream(receiptPath));

    console.log("📌 Uploading receipt...");
    const uploadResp = await axios.post(
      `${BASE_URL}/upload-receipt/${paymentId}`,
      formData,
      { headers: formData.getHeaders(), timeout: 10000 }
    );

    console.log("✅ Receipt uploaded:", uploadResp.data);

  } catch (err) {
    if (err.code === 'ECONNABORTED') {
      console.error("❌ Request timed out. The server is not responding.");
    } else {
      console.error("❌ Test failed:", err.response?.data || err.message);
    }
  }
}

testPaymentFlow();