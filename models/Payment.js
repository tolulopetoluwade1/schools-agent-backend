module.exports = (sequelize, DataTypes) => {
  const Payment = sequelize.define(
    "Payment",
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },

      schoolId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },

      parentId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },

      studentId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },

      amount: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },

      paymentMethod: {
        type: DataTypes.STRING,
        defaultValue: "bank_transfer",
      },

      currency: {
        type: DataTypes.STRING,
        defaultValue: "NGN",
      },

      status: {
        type: DataTypes.STRING,
        defaultValue: "pending",
      },

      paystackReference: {
        type: DataTypes.STRING,
        allowNull: true,
      },

      // NEW FIELD for receipt upload
      receiptImage: {
        type: DataTypes.STRING,
        allowNull: true,
      },
    },
    {
      tableName: "payments",
      timestamps: true,
    }
  );

  return Payment;
};