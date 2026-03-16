const express = require("express");
const multer = require("multer");
const { sendWhatsAppText } = require("../services/whatsapp");

const StudentModel = require("../models/Student");
const ParentModel = require("../models/Parent");

module.exports = (PaymentInstallment) => {
  const router = express.Router();
  const Student = StudentModel(PaymentInstallment.sequelize, require("sequelize").DataTypes);
  const Parent = ParentModel(PaymentInstallment.sequelize, require("sequelize").DataTypes);

  // ---------------------
  // Multer storage config
  // ---------------------
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, "uploads/"),
    filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname),
  });

  const upload = multer({ storage });

  // ---------------------
  // CREATE payment (full or installments)
  // POST /api/installments
  // ---------------------
  router.post("/", async (req, res) => {
    try {
      const { schoolId, studentId, totalAmount, installments } = req.body;

      if (!schoolId || !studentId || !totalAmount) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      // determine number of installments
      const numInstallments =
        !installments || Number(installments) <= 1 ? 1 : Number(installments);

      const installmentAmount = Math.floor(totalAmount / numInstallments);

      let dueDate = new Date();
      const createdInstallments = [];

      for (let i = 0; i < numInstallments; i++) {
        if (i > 0) {
          dueDate.setMonth(dueDate.getMonth() + 1);
        }

        const installment = await PaymentInstallment.create({
          schoolId,
          studentId,
          totalAmount,
          amountDue: installmentAmount,
          dueDate,
          status: "pending",
        });

        createdInstallments.push(installment);
      }

      // ---------------------
      // WhatsApp notification
      // ---------------------
      const student = await Student.findByPk(studentId);

      if (student) {
        const parent = await Parent.findByPk(student.parentId);

        if (parent && parent.phone) {
          let message;

          if (numInstallments === 1) {
            message = `📢 School Fee Created

Hello,

A full school fee of ₦${Number(totalAmount).toLocaleString()} has been created for ${student.fullName}.

Please ensure payment promptly.`;
          } else {
            message = `📢 School Fee Created

Hello,

A school fee of ₦${Number(totalAmount).toLocaleString()} has been created for ${student.fullName}.

Installment plan:

${createdInstallments
  .map(
    (i) =>
      `₦${Number(i.amountDue).toLocaleString()} — due ${new Date(
        i.dueDate
      ).toLocaleDateString()}`
  )
  .join("\n")}

Please ensure payment before the due dates.`;
          }

          await sendWhatsAppText(parent.phone, message);
        }
      }

      res.json({
        message:
          numInstallments === 1
            ? "Full payment created"
            : "Installments created",
        createdInstallments,
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Server error" });
    }
  });

  // ---------------------
  // UPLOAD receipt
  // POST /api/installments/:installmentId/receipt
  // ---------------------
  router.post(
    "/:installmentId/receipt",
    upload.single("receipt"),
    async (req, res) => {
      try {
        const installment = await PaymentInstallment.findByPk(
          req.params.installmentId
        );

        if (!installment)
          return res.status(404).json({ error: "Installment not found" });

        if (!req.file)
          return res.status(400).json({ error: "No receipt uploaded" });

        installment.receiptImage = req.file.path;
        installment.status = "paid";

        await installment.save();

        res.json({
          message: "Installment paid successfully",
          installment,
        });
      } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server error" });
      }
    }
  );

  // ---------------------
  // GET installments for student
  // GET /api/installments/student/:studentId
  // ---------------------
  router.get("/student/:studentId", async (req, res) => {
    try {
      const installments = await PaymentInstallment.findAll({
        where: { studentId: req.params.studentId },
      });

      res.json({ success: true, installments });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Server error" });
    }
  });

  return router;
};
