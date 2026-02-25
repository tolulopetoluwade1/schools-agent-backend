module.exports = (sequelize, DataTypes) => {
  const School = sequelize.define(
    "School",
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },

      name: {
        type: DataTypes.STRING,
        allowNull: false,
      },

      timezone: {
        type: DataTypes.STRING,
        allowNull: true,
      },
    },
    {
      tableName: "schools",
      timestamps: true,
    }
  );

  return School;
};

