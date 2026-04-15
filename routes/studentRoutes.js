const express = require("express");

module.exports = (Student) => {
  const router = express.Router();

  // CREATE STUDENT
  router.post("/", async (req, res) => {
    try {
      const { schoolId, parentId, fullName, className, termFee } = req.body;

      if (!schoolId || !parentId || !fullName || !className || !termFee) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      const student = await Student.create({
          schoolId,
          parentId,
          fullName,
          className,
          termFee,
        });

      return res.json({
        success: true,
        student,
      });
    } catch (error) {
      console.error("Create student error:", error);
      return res.status(500).json({ error: "Server error" });
    }
  });

  return router;
};