// aiAgent.js

// Example school data
const schoolData = {
  "tolulope": {
    studentName: "Tolulope Toluwade",
    balance: 20000,
    teacher: "Mrs. Johnson",
    nextEvent: "Sports Day on 25th March"
  },
  "ebun": {
    studentName: "Ebunoluwa Toluwade",
    balance: 15000,
    teacher: "Mr. Ade",
    nextEvent: "Science Fair on 30th March"
  }
  // Add more students/parents here
};

function getAIResponse(userMessage) {
  const message = userMessage.toLowerCase();

  // Try to find the student's data by parent/student name in the message
  let studentKey = null;
  for (const key in schoolData) {
    if (message.includes(key)) {
      studentKey = key;
      break;
    }
  }

  const student = studentKey ? schoolData[studentKey] : null;

  // Respond dynamically based on message content
  if (student) {
    if (message.includes('balance') || message.includes('fees')) {
      return `${student.studentName}'s current balance is ₦${student.balance}.`;
    }

    if (message.includes('teacher')) {
      return `${student.studentName}'s teacher is ${student.teacher}.`;
    }

    if (message.includes('event')) {
      return `The next school event for ${student.studentName} is ${student.nextEvent}.`;
    }

    if (message.includes('hello') || message.includes('hi')) {
      return `Hello! How can I help you regarding ${student.studentName}?`;
    }

    // Default for other messages
    return `AI says: I got your message "${userMessage}" about ${student.studentName}.`;
  }

  // Default response if student not found
  return `I could not find a student in your message. Please include the student's name.`;
}

module.exports = { getAIResponse };