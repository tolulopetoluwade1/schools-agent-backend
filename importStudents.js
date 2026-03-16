// backend/importStudents.js
const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");
const { sequelize, DataTypes } = require("./db"); // db.js we just made
const StudentModel = require("./models/Student");
const ParentModel = require("./models/Parent");

// Initialize models
const Parent = ParentModel(sequelize, DataTypes);
const Student = StudentModel(sequelize, DataTypes);

(async () => {
  try {
    // Make sure tables exist
    await sequelize.sync({ alter: true });

    const studentsFilePath = path.join(__dirname, "students.csv"); // CSV file path

    const students = [];

    fs.createReadStream(studentsFilePath)
      .pipe(csv())
      .on("data", (row) => {
        // Each row should have: name, parentId, schoolId
        students.push({
        fullName: row.fullName,
        className: row.className,
        termFee: Number(row.termFee),
        parentId: Number(row.parentId),
        schoolId: Number(row.schoolId),
      });
      })
      .on("end", async () => {
        console.log(`📥 Importing ${students.length} students...`);

        for (const student of students) {
          // Check if parent exists
          const parent = await Parent.findByPk(student.parentId);
          if (!parent) {
            console.warn(`⚠️ Parent ID ${student.parentId} not found, skipping student ${student.name}`);
            continue;
          }

          await Student.create(student);
          console.log(`✅ Student created: ${student.fullName}`);
        }

        console.log("🎉 Student import finished!");
        process.exit(0);
      });
  } catch (err) {
    console.error("❌ Error importing students:", err.message);
    process.exit(1);
  }
})();