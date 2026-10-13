const pretestScore = 0;
const posttestScore = 0;
const Status = 'attempted';
const Score = 0;
const duration = 0;
// Example: Log to console
console.log({ pretestScore, posttestScore, Status, Score, duration });

localStorage.setItem('pretestScore', pretestScore);
localStorage.setItem('posttestScore', posttestScore);
localStorage.setItem('Status', Status);
localStorage.setItem('Score', Score);
localStorage.setItem('duration', duration);

setTimeout(() => {
    window.parent.postMessage({
        pretestScore: pretestScore,
        posttestScore: posttestScore,
        duration: duration,
        Status: Status,
        Score: Score,
    }, "*");
}, 3000);



document.getElementById("quiz-form").addEventListener("submit", function (event) {
    event.preventDefault();
    const formData = new FormData(event.target);

    // Fetch the correct answers embedded in the HTML
    const correctAnswers = document.querySelectorAll(".question");
    let score = 0;

    correctAnswers.forEach((questionElement, index) => {
        const correctAnswer = questionElement.dataset.correctAnswer; // Get the correct answer
        const userAnswer = formData.get(`question${index}`); // Get the user's answer

        if (userAnswer === correctAnswer) {
            score += 10; // Add 10 marks for a correct answer
        }
    });

    console.log("Total Score:", score);

    // Save the score in localStorage
    localStorage.setItem("Score", score);
    localStorage.setItem("pretestScore", score);

    alert(`Quiz submitted! Your total score is ${score}.`);

    // Send the score to the parent (if needed)
    window.parent.postMessage({
        pretestScore: localStorage.getItem("pretestScore"),
        posttestScore: localStorage.getItem("posttestScore"),
        duration: localStorage.getItem("duration"),
        Status: localStorage.getItem("Status"),
        Score: score, // Updated score
    }, "*");

    // Hide the Pretest section and show the Posttest section
    document.getElementById("pretest-section").style.display = "none";
    document.getElementById("posttest-section").style.display = "block";
    document.getElementById("thank-you").style.display = "none";
});


document.getElementById("quiz-form-posttest").addEventListener("submit", function (event) {
    event.preventDefault();
    const formData = new FormData(event.target);

    // Fetch the correct answers embedded in the HTML
    const correctAnswers = document.querySelectorAll(".question");
    let score = 0;

    correctAnswers.forEach((questionElement, index) => {
        const correctAnswer = questionElement.dataset.correctAnswer; // Get the correct answer
        const userAnswer = formData.get(`question${index}`); // Get the user's answer

        if (userAnswer === correctAnswer) {
            score += 10; // Add 10 marks for a correct answer
        }
    });

    console.log("Total Score:", score);

    // Save the score in localStorage
    localStorage.setItem("Score", score);
    localStorage.setItem("posttestScore", score);

    alert(`Quiz submitted! Your total score is ${score}.`);

    // Send the score to the parent (if needed)
    window.parent.postMessage({
        pretestScore: localStorage.getItem("pretestScore"),
        posttestScore: localStorage.getItem("posttestScore"),
        duration: localStorage.getItem("duration"),
        Status: "completed",
        Score: score, // Updated score
    }, "*");

    // Hide the Pretest section and show the Posttest section
    document.getElementById("pretest-section").style.display = "none";
    document.getElementById("posttest-section").style.display = "none";
    document.getElementById("thank-you").style.display = "block";
});




