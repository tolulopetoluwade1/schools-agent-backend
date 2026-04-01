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
      address: {
      type: DataTypes.STRING,
      allowNull: true,
      },

      mapsLink: {
        type: DataTypes.STRING,
        allowNull: true,
      },

      timezone: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      aiKnowledge: {
      type: DataTypes.TEXT,
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

