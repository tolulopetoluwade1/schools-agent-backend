const express = require("express");
const multer = require("multer");

module.exports = (Payment) => {

const router = express.Router();


// Configure Multer storage
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "uploads/");
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + "-" + file.originalname);
  }
});

const upload = multer({ storage: storage });


// Create payment request
router.post("/request", async (req, res) => {
  try {

    console.log("📌 Payment request received");
    console.log("Request body:", req.body);

    const { schoolId, parentId, studentId, amount, description } = req.body;

    const payment = await Payment.create({
      schoolId,
      parentId,
      studentId,
      amount,
      description,
      status: "pending"
    });

    console.log("✅ Payment created in DB");

    res.json({
      message: "Payment request created",
      payment
    });

  } catch (error) {
    console.error("❌ Error creating payment:", error);
    res.status(500).json({ error: "Server error" });
  }
});


// Upload payment receipt
router.post("/upload-receipt/:paymentId", upload.single("receipt"), async (req, res) => {
  try {

    console.log("📌 Upload receipt request");

    const payment = await Payment.findByPk(req.params.paymentId);

    if (!payment) {
      return res.status(404).json({ error: "Payment not found" });
    }

    if (!req.file) {
      return res.status(400).json({ error: "No receipt uploaded" });
    }

    payment.receiptImage = req.file.path;

    // Automatically approve payment
    payment.status = "paid";

    await payment.save();


    console.log("✅ Receipt uploaded and saved");

    res.json({
      message: "Receipt uploaded successfully",
      payment
    });

  } catch (error) {
    console.error("❌ Error uploading receipt:", error);
    res.status(500).json({ error: "Server error" });
  }
});
// Get all payments for a student
router.get("/student/:studentId", async (req, res) => {
  try {

    const payments = await Payment.findAll({
      where: {
        studentId: req.params.studentId
      },
      order: [["createdAt", "DESC"]]
    });

    res.json({
      success: true,
      payments
    });

  } catch (error) {
    console.error("Error fetching payments:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// Create installment payment plan
router.post("/installment/create", async (req, res) => {
  try {

    const { schoolId, studentId, totalAmount, installments } = req.body;

    const createdInstallments = [];

    for (let i = 0; i < installments.length; i++) {

      const installment = await PaymentInstallment.create({
        schoolId: schoolId,
        studentId: studentId,
        totalAmount: totalAmount,
        amountDue: installments[i].amount,
        dueDate: installments[i].dueDate,
        status: "pending"
      });

      createdInstallments.push(installment);
    }

    res.json({
      success: true,
      message: "Installment plan created",
      installments: createdInstallments
    });

  } catch (error) {

    console.error("Installment creation error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to create installment plan"
    });

  }
});

return router;

};