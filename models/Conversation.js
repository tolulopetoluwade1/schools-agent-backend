module.exports = (sequelize, DataTypes) => {
  const Conversation = sequelize.define(
    "Conversation",
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

      channel: {
        type: DataTypes.ENUM("whatsapp", "telegram"),
        allowNull: false,
      },

      status: {
        type: DataTypes.ENUM("open", "closed", "completed"),
        allowNull: false,
        defaultValue: "open",
      },

      lastMessageAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      admissionStep: {
  type: DataTypes.STRING,
  allowNull: true, // null means "not started"
},

childName: {
  type: DataTypes.STRING,
  allowNull: true,
},

childAge: {
  type: DataTypes.STRING,
  allowNull: true,
},

desiredClass: {
  type: DataTypes.STRING,
  allowNull: true,
},
feeAmount: { type: DataTypes.INTEGER, allowNull: true },
feeCurrency: { type: DataTypes.STRING, allowNull: true },
awaitingInvoiceConsent: {
  type: DataTypes.BOOLEAN,
  allowNull: false,
  defaultValue: false,
},
awaitingInvoiceDetails: {
  type: DataTypes.BOOLEAN,
  defaultValue: false,
},

invoiceStatus: {
  type: DataTypes.STRING,
  allowNull: false,
  defaultValue: "none",
},

    },
    {
      tableName: "conversations",
      timestamps: true,

      // One conversation per parent per channel per school
      indexes: [{ unique: true, fields: ["schoolId", "parentId", "channel"] }],
    }
  );

  return Conversation;
};
