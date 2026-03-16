module.exports = (sequelize, DataTypes) => {

  const PaymentInstallment = sequelize.define("PaymentInstallment", {

    schoolId: {
      type: DataTypes.INTEGER,
      allowNull: false
    },

    studentId: {
      type: DataTypes.INTEGER,
      allowNull: false
    },

    totalAmount: {
      type: DataTypes.INTEGER,
      allowNull: false
    },

    amountDue: {
      type: DataTypes.INTEGER,
      allowNull: false
    },

    dueDate: {
      type: DataTypes.DATE,
      allowNull: false
    },

    status: {
      type: DataTypes.STRING,
      defaultValue: "pending"
    }

  });

  return PaymentInstallment;
};