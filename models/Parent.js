module.exports = (sequelize, DataTypes) => {
  const Parent = sequelize.define(
    "Parent",
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },

      // This connects a parent to a specific school
      schoolId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },

      // Parent phone number (WhatsApp number)
      phone: {
        type: DataTypes.STRING,
        allowNull: false,
      },

      // Optional for now
      fullName: {
        type: DataTypes.STRING,
        allowNull: true,
      },
    },
    {
      tableName: "parents",
      timestamps: true,

      // Prevent duplicate parent records in the same school
      indexes: [{ unique: true, fields: ["schoolId", "phone"] }],
    }
  );

  return Parent;
};
