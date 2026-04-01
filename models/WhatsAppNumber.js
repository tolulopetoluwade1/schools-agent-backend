// models/WhatsAppNumber.js
module.exports = (sequelize, DataTypes) => {
  return sequelize.define("WhatsAppNumber", {
    phoneNumber: {
      type: DataTypes.STRING,
      unique: true,
      allowNull: false,
    },
    schoolId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    telegramId: {            // <-- Add this
      type: DataTypes.STRING,
      allowNull: true,       // can be empty at first
    },
  });
};