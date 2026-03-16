// backend/db.js
const { Sequelize, DataTypes } = require("sequelize");
require("dotenv").config();

// Create Sequelize instance
const sequelize = new Sequelize(
  process.env.DB_NAME,     // Database name
  process.env.DB_USER,     // Database user
  process.env.DB_PASS,     // Database password
  {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    dialect: "postgres",
    logging: console.log, // Set to false to disable SQL logs
  }
);

// Test DB connection
(async () => {
  try {
    await sequelize.authenticate();
    console.log("✅ DB connected successfully!");
  } catch (err) {
    console.error("❌ DB connection error:", err.message);
  }
})();

module.exports = { sequelize, DataTypes };