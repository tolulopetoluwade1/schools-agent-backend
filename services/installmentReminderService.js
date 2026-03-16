const cron = require("node-cron");

module.exports = (PaymentInstallment, Parent, Student, sendWhatsAppText) => {
  // runs every minute for testing; change schedule for production
  cron.schedule("* * * * *", async () => {
    console.log("Running installment reminder check...");

    const today = new Date();
    const reminderDate = new Date();
    reminderDate.setDate(today.getDate() + 3); // 3 days before due

    // Get all pending installments
    const dueInstallments = await PaymentInstallment.findAll({
      where: { status: "pending" },
    });

    for (let installment of dueInstallments) {
      const student = await Student.findByPk(installment.studentId);
      if (!student) continue;

      const parent = await Parent.findByPk(student.parentId);
      if (!parent) continue;

      const dueDate = new Date(installment.dueDate);

      // Determine if this is a multi-installment plan
      const installmentsCount = await PaymentInstallment.count({
        where: { studentId: student.id, totalAmount: installment.totalAmount },
      });

      // Skip reminders for full payment (single installment)
      if (installmentsCount === 1) continue;

      // Only send if due date is within 3 days
      if (dueDate <= reminderDate) {
        const message = `Reminder: ${student.fullName}'s installment of ₦${installment.amountDue.toLocaleString()} is due on ${dueDate.toLocaleDateString()}. Please make payment promptly.`;
        console.log("Reminder (console):", message);

        if (parent?.phone) {
          try {
            await sendWhatsAppText(parent.phone, message);
            console.log(`✅ WhatsApp sent to ${parent.phone}`);
          } catch (err) {
            console.error(`❌ WhatsApp failed for ${parent.phone}:`, err.message);
          }
        }
      }
    }
  });
};