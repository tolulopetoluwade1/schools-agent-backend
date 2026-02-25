module.exports = (sequelize, DataTypes) => {
  const Message = sequelize.define(
    "Message",
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },

      conversationId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },

      direction: {
        type: DataTypes.ENUM("inbound", "outbound"),
        allowNull: false,
      },

      from: {
        type: DataTypes.STRING,
        allowNull: false,
      },

      text: {
        type: DataTypes.TEXT,
        allowNull: false,
      },

      providerTimestamp: {
        type: DataTypes.DATE,
        allowNull: true,
      },
    },
    {
      tableName: "messages",
      timestamps: true,
    }
  );

  return Message;
};
