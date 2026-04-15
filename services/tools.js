// services/tools.js

/**
 * TOOL: Get all students owing fees
 */
async function getOwingStudents({ PaymentInstallment, Student, schoolId }) {
  try {
    const records = await PaymentInstallment.findAll({
      where: { schoolId, status: "pending" },
      include: [{ model: Student, attributes: ["id", "fullName"] }],
    });

    const summary = {};

    records.forEach(r => {
      const name = r.Student?.fullName || "Unknown";
      const code = "STD-" + r.Student?.id;
      const amount = r.amountDue || 0;

      if (!summary[name]) {
        summary[name] = {
          name,
          studentCode: code,
          amount: 0
        };
      }

      summary[name].amount += amount;
    });

    return {
      success: true,
      data: Object.values(summary)
    };

  } catch (error) {
    console.error("❌ Tool Error (getOwingStudents):", error);

    return {
      success: false,
      data: []
    };
  }
}


/**
 * TOOL: Get school basic info
 */
async function getSchoolInfo({ school }) {
  return {
    success: true,
    data: {
      name: school.name,
      address: school.address,
      knowledge: school.aiKnowledge
    }
  };
}

async function getTotalOutstanding({ PaymentInstallment, schoolId }) {
  try {
    const records = await PaymentInstallment.findAll({
      where: { schoolId, status: "pending" }
    });

    const total = records.reduce((sum, r) => {
      return sum + (r.amountDue || 0);
    }, 0);

    return {
      success: true,
      data: total
    };

  } catch (error) {
    console.error("❌ Tool Error (getTotalOutstanding):", error);

    return {
      success: false,
      data: 0
    };
  }
}

module.exports = {
  getOwingStudents,
  getSchoolInfo,
  getTotalOutstanding
};