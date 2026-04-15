const express = require("express");

module.exports = (School) => {
  const router = express.Router();

  // CREATE SCHOOL
  router.post("/", async (req, res) => {
    try {
      const { name, address } = req.body;

      if (!name || !address) {
        return res.status(400).json({
          success: false,
          message: "Name and address are required",
        });
      }

      const school = await School.create({
        name,
        address,
      });

      res.json({
        success: true,
        school,
      });
    } catch (error) {
      console.error("Create school error:", error);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  return router;
};