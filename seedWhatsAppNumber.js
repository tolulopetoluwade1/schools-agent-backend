require("dotenv").config();
const { Sequelize, DataTypes } = require("sequelize");
const WhatsAppNumberModel = require("./models/WhatsAppNumber");
const SchoolModel = require("./models/School");

const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASS,
  { host: process.env.DB_HOST, port: process.env.DB_PORT, dialect: "postgres" }
);

const School = SchoolModel(sequelize, DataTypes);
const WhatsAppNumber = WhatsAppNumberModel(sequelize, DataTypes);

School.hasMany(WhatsAppNumber, { foreignKey: "schoolId" });
WhatsAppNumber.belongsTo(School, { foreignKey: "schoolId" });

(async () => {
  await sequelize.sync();

  // Example: School with ID 1
  await WhatsAppNumber.create({
    phoneNumber: "+2348130000000", // replace with the actual number of the school
    schoolId: 1,
  });

  console.log("✅ WhatsApp number seeded");
  process.exit();
})();