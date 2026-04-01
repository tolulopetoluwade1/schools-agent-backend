async function updateAiKnowledge(School, PaymentInstallment, Student) {
  try {
    const schools = await School.findAll();
    const { Op } = require("sequelize");

    for (const school of schools) {

      // =========================
      // 1️⃣ GET OWING STUDENTS
      // =========================
      const installments = await PaymentInstallment.findAll({
        where: {schoolId: school.id,amountDue: { [Op.gt]: 0 }},
        include: [{ model: Student, attributes: ["id", "fullName"] }],
      });

      let totalOwing = 0;
      const uniqueStudents = new Set();

      installments.forEach(inst => {
        totalOwing += inst.amountDue || 0;
        if (inst.Student) {
          uniqueStudents.add(inst.Student.id);
      }
      });

      // =========================
      // 2️⃣ BUILD AI KNOWLEDGE
      // =========================
      const knowledge = JSON.stringify({
        school: {
          name: school.name,
          address: school.address,
        },
        fees: {
          nursery: 25000,
          primary: 40000,
        },
       stats: {
        studentsOwing: uniqueStudents.size,
        totalOwing: totalOwing,
        },
      });

      // =========================
      // 3️⃣ SAVE BACK TO DB
      // =========================
      school.aiKnowledge = knowledge;
      await school.save();

      console.log(`✅ AI Knowledge updated for ${school.name}`);
    }

  } catch (err) {
    console.error("❌ AI Knowledge update failed:", err.message);
  }
}

module.exports = updateAiKnowledge;