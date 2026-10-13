// trainingAss_Template.js - FIXED VERSION

const posttestScoreKey = 'posttestScore';
const durationKey = 'duration';
const statusKey = 'Status';
const scoreKey = 'Score';

localStorage.setItem(posttestScoreKey, 0);
localStorage.setItem(durationKey, 0);
localStorage.setItem(statusKey, 'not attempted');
localStorage.setItem(scoreKey, 0);

let startTime = Date.now();

function getDurationInSeconds() {
    const endTime = Date.now();
    return Math.floor((endTime - startTime) / 1000);
}

function sendLMSMessage(score, status, duration) {
    window.parent.postMessage({
        type: "SCORM_DATA", // ✅ Added type for proper message filtering
        posttestScore: score,
        duration: duration,
        Status: status,
        Score: score,
        ts: Date.now() // ✅ Added timestamp for deduplication
    }, "*");
}

// --- Navigation Logic ---
const trainingSection = document.getElementById("training-section");
const posttestSection = document.getElementById("posttest-section");
const thankYouSection = document.getElementById("thank-you");

if (trainingSection) trainingSection.style.display = "block";
if (posttestSection) posttestSection.style.display = "none";
if (thankYouSection) thankYouSection.style.display = "none";

const nextButton = document.getElementById("next-session");
if (nextButton) {
    nextButton.addEventListener("click", () => {
        if (trainingSection) trainingSection.style.display = "none";
        if (posttestSection) posttestSection.style.display = "block";
        if (thankYouSection) thankYouSection.style.display = "none";
    });
}

// --- Posttest Submission Logic ---
const quizFormPosttest = document.getElementById("quiz-form-posttest");

if (quizFormPosttest) {
    quizFormPosttest.addEventListener("submit", async function (event) {
        event.preventDefault();
        
        const courseID = event.target.dataset.courseId;
        const formData = new FormData(event.target);
        const correctAnswers = document.querySelectorAll(".question");
        const totalQuestions = correctAnswers.length;
        
        let score = 0;
        let allAnswers = [];

        // Calculate Score and Collect Answers
        const marksPerQuestion = 100 / totalQuestions;
        
        correctAnswers.forEach((questionElement, index) => {
            const correctAnswer = questionElement.dataset.correctAnswer;
            const userAnswer = formData.get(`question${index}`);
            const questionNumber = questionElement.dataset.questionNumber;
            
            const questionTextElement = questionElement.querySelector('p strong');
            const questionText = questionTextElement ? questionTextElement.textContent.split('. ')[1] : `Question ${questionNumber}`;

            let isCorrect = false;

            if (userAnswer && userAnswer.trim() === correctAnswer.trim()) {
                score += marksPerQuestion;
                isCorrect = true;
            }

            allAnswers.push({
                qNum: questionNumber,
                question: questionText,
                userAnswer: userAnswer || 'Not Answered',
                correctAnswer: correctAnswer,
                isCorrect: isCorrect
            });
        });

        const finalScore = Math.round(score);
        const duration = getDurationInSeconds();
        const currentDate = new Date().toISOString().slice(0, 10);
        const allAnswersJson = JSON.stringify(allAnswers);

        localStorage.setItem(posttestScoreKey, finalScore);
        localStorage.setItem(scoreKey, finalScore);
        localStorage.setItem(durationKey, duration);
        localStorage.setItem(statusKey, "completed");

        // ✅ FIX 1: Fetch user session data from server FIRST
        let userData;
        try {
            const sessionResponse = await fetch('/api/get-current-user');
            if (!sessionResponse.ok) {
                throw new Error('Failed to fetch user session');
            }
            userData = await sessionResponse.json();
        } catch (error) {
            console.error('Error fetching user session:', error);
            alert('Error: Unable to identify user. Please log in again.');
            return;
        }

        // ✅ FIX 2: Prepare submission data with REAL user info
        const submissionData = {
            courseID: courseID,
            uniqueID: userData.uniqueID, // ✅ Real data from session
            employeeID: userData.employeeID, // ✅ Real data from session
            name: userData.name, // ✅ Real data from session
            score: finalScore,
            duration: duration,
            date: currentDate,
            allAnswersJson: allAnswersJson
        };

        // ✅ FIX 3: Send to correct backend route
        try {
            const response = await fetch('/submitPosttestData', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(submissionData),
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(errorText);
            }

            const data = await response.text();
            console.log("Server response:", data);
            alert(`Posttest submitted successfully! Your score is ${finalScore}.`);
            
        } catch (error) {
            console.error('Error submitting posttest data:', error);
            alert(`Score: ${finalScore}. Error saving to server: ${error.message}`);
        } finally {
            // Always send LMS message and update UI
            sendLMSMessage(finalScore, 'completed', duration);

            if (trainingSection) trainingSection.style.display = "none";
            if (posttestSection) posttestSection.style.display = "none";
            if (thankYouSection) thankYouSection.style.display = "block";
        }
    });
}