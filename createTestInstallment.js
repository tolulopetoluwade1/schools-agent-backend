require("dotenv").config();

const { Sequelize, DataTypes } = require("sequelize");

// connect to DB (same env variables as server.js)
const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASS,
  {
    host: process.env.DB_HOST,
    dialect: "postgres",
  }
);

// load models the same way server.js does
const StudentModel = require("./models/Student");
const PaymentInstallmentModel = require("./models/PaymentInstallment");

const Student = StudentModel(sequelize, DataTypes);
const PaymentInstallment = PaymentInstallmentModel(sequelize, DataTypes);

(async () => {
  try {

    await sequelize.authenticate();

    // get first student
    const student = await Student.findOne();

    if (!student) {
      console.log("❌ No students found in DB");
      process.exit();
    }

    const installment = await PaymentInstallment.create({
      schoolId: 1,
      studentId: student.id,
      totalAmount: 60000,
      amountDue: 20000,
      dueDate: new Date(new Date().setDate(new Date().getDate() + 2)),
      status: "pending"
    });

    console.log("✅ Test installment created:");
    console.log(installment.toJSON());

    process.exit();

  } catch (err) {
    console.error("❌ Error:", err);
  }
})();