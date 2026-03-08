module.exports = (sequelize, DataTypes) => {
  const Student = sequelize.define(
    "Student",
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

      fullName: {
        type: DataTypes.STRING,
        allowNull: false,
      },

      className: {
        type: DataTypes.STRING,
        allowNull: false,
      },

      termFee: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
    },
    {
      tableName: "students",
      timestamps: true,
    }
  );

  return Student;
};