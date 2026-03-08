const mongoose = require("mongoose");

const studentSchema = new mongoose.Schema({

  name: {
    type: String,
    required: true
  },

  class: {
    type: String,
    required: true
  },

  parent: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Parent",
    required: true
  },

  school: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "School",
    required: true
  },

  fees: {
    type: Number,
    required: true
  }

}, { timestamps: true });

module.exports = mongoose.model("Student", studentSchema);