const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');
const path = require('path');
const fs = require('fs');
const fsPromises = fs.promises;
const xml2js = require('xml2js');
const cors = require('cors');
const bodyParser = require('body-parser');
const jsonexport = require('jsonexport');
const mysql = require('mysql2');
const xlsx = require('xlsx');
const { v4: uuidv4 } = require('uuid');
const { Parser } = require('json2csv');
const { execFile } = require('child_process');
// Generates QR codes fully offline, server-side (no CDN/runtime network
// dependency). One-time setup step: run `npm install` in the project folder
// so this package is present in node_modules.
const QRCode = require('qrcode');
// app.use(express.json({ limit: '10mb' })); 

const app = express();
const upload = multer({ dest: 'uploads/' });

const session = require('express-session');

// Configure session middleware
app.use(session({
  secret: 'your_secret_key',
  resave: false,
  saveUninitialized: false
}));


// Apply requireAuth middleware to routes that require authentication
//app.use(['/addUser', '/save-details', '/upload', '/logout', '/getUploadedScorms', '/getCourseList', '/updateUserSCORMData'], requireAuth);


// Serve user photos statically
app.use('/photos', express.static(path.join(__dirname, 'public/photos')));

const currentDate = new Date().toLocaleDateString('en-GB', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric'
})
// .replace(/\//g, '');

const currentTime = new Date().toLocaleTimeString('en-US', {
  hour12: false,
  hour: '2-digit',
  minute: '2-digit',
})
// .replace(/:/g, '');

// Enable CORS for all routes
app.use(cors());

app.get('/addUser', (req, res) => {
  res.render('addUser.html', { currentDate, currentTime });
});


app.use(bodyParser.json({ limit: '2500mb' }));
app.use(bodyParser.urlencoded({ limit: '2500mb', extended: true }));

const connection = mysql.createConnection({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: Number(process.env.DB_PORT || 3306)
});
function calculateRefreshalDate(courseDate, refreshalMonths) {
  if (!courseDate || !refreshalMonths) {
    return null;
  }

  const months = parseInt(refreshalMonths, 10);
  if (Number.isNaN(months)) {
    return null;
  }

  const baseCourseDate = new Date(courseDate);
  if (Number.isNaN(baseCourseDate.getTime())) {
    return null;
  }

  const refreshalDate = new Date(baseCourseDate);
  refreshalDate.setMonth(refreshalDate.getMonth() + months);

  return refreshalDate.toISOString().split('T')[0];
}

function ensureCourseRefreshalColumn() {
  const query = `
    ALTER TABLE courses
    ADD COLUMN RT_Date DATE NULL
  `;

  connection.query(query, (error) => {
    if (!error) {
      console.log('courses.RT_Date column is ready');
      return;
    }

    if (error.code === 'ER_DUP_FIELDNAME') {
      console.log('courses.RT_Date column already exists');
      return;
    }

    if (error.code === 'ER_NO_SUCH_TABLE') {
      console.log('Legacy courses table not found; using normalized subcourses schema');
      return;
    }

    console.error('Error ensuring courses.RT_Date column:', error);
  });
}

ensureCourseRefreshalColumn();

// Harman-style "Level 1 completed -> acknowledge -> enroll for Level 2+" pipeline.
// This table does not exist in the original dump set, so it is bootstrapped
// here (the app does not auto-create most tables, but this one is new).
function ensureL1CompletedUsersTable() {
  const query = `
    CREATE TABLE IF NOT EXISTS l1completedusers (
      id INT NOT NULL AUTO_INCREMENT,
      uniqueID INT NOT NULL,
      level1StartDate DATE DEFAULT NULL,
      levelDate DATE DEFAULT NULL,
      l1Status VARCHAR(20) DEFAULT NULL,
      acknowledgeDate DATETIME DEFAULT NULL,
      acknowledgedBy INT DEFAULT NULL,
      sentForNextLevel TINYINT(1) DEFAULT 0,
      assignedDeptID INT DEFAULT NULL,
      assignedAreaID INT DEFAULT NULL,
      assignedMCourseID INT DEFAULT NULL,
      l2TempStartDate DATE DEFAULT NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_l1completed_user (uniqueID)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `;
  connection.query(query, (error) => {
    if (error) {
      console.error('Error ensuring l1completedusers table:', error);
      return;
    }
    console.log('l1completedusers table is ready');
  });
}

ensureL1CompletedUsersTable();

// Deleted-learner audit trail: when an admin deletes a user from
// learnersList.html, we snapshot the row + the reason they gave instead of
// just losing the data, so there's a "Past Users" list to look back at.
function ensureDeletedUsersTable() {
  const query = `
    CREATE TABLE IF NOT EXISTS deletedusers (
      id INT NOT NULL AUTO_INCREMENT,
      originalUniqueID INT DEFAULT NULL,
      name VARCHAR(255) DEFAULT NULL,
      emailID VARCHAR(255) DEFAULT NULL,
      employeeID VARCHAR(100) DEFAULT NULL,
      uName VARCHAR(100) DEFAULT NULL,
      uPass VARCHAR(100) DEFAULT NULL,
      mobileNo VARCHAR(50) DEFAULT NULL,
      department VARCHAR(255) DEFAULT NULL,
      uRole VARCHAR(100) DEFAULT NULL,
      registerDate DATETIME DEFAULT NULL,
      reason TEXT DEFAULT NULL,
      deletedBy INT DEFAULT NULL,
      deletedByName VARCHAR(255) DEFAULT NULL,
      deletedDate DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `;
  connection.query(query, (error) => {
    if (error) {
      console.error('Error ensuring deletedusers table:', error);
      return;
    }
    console.log('deletedusers table is ready');
  });
}

ensureDeletedUsersTable();

// ====================================================================
// STATION (= Machine) support: a new level under Process/Line.
// Department -> Segment/Area -> Process/Line -> Station.
// All of this is additive: existing subcourses/enrollstatus/
// l2-4completedusers rows keep stationID = NULL, which every updated query
// below treats as "whole Line" (matching how areaID/mCourseID already work
// when left blank elsewhere in this app) - so nothing that already works
// today changes behavior. Only NEW enrollment/acknowledgement going forward
// is expected to always pick a station.
// ====================================================================

function safeAlter(query, label) {
  connection.query(query, (error) => {
    if (error) {
      // ER_DUP_FIELDNAME (1060) / ER_CANT_DROP_FIELD_OR_KEY (1091) / ER_DUP_KEYNAME (1061)
      // mean this migration already ran on a previous server start - that's fine.
      if (['ER_DUP_FIELDNAME', 'ER_CANT_DROP_FIELD_OR_KEY', 'ER_DUP_KEYNAME'].includes(error.code)) return;
      console.error(`Error running station migration (${label}):`, error.message);
      return;
    }
    console.log(`Station migration OK: ${label}`);
  });
}

function ensureStationsTable() {
  const query = `
    CREATE TABLE IF NOT EXISTS stations (
      stationID INT NOT NULL AUTO_INCREMENT,
      deptID INT DEFAULT NULL,
      areaID INT DEFAULT NULL,
      mCourseID INT NOT NULL,
      stationName VARCHAR(255) NOT NULL,
      stationDescription TEXT,
      stationDate DATE DEFAULT NULL,
      PRIMARY KEY (stationID)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `;
  connection.query(query, (error) => {
    if (error) {
      console.error('Error ensuring stations table:', error);
      return;
    }
    console.log('stations table is ready');

    // Optional headcount needed to run this station. Nullable - not every
    // station needs to report this, so it's never required on the form.
    safeAlter('ALTER TABLE stations ADD COLUMN requiredManpower INT DEFAULT NULL', 'stations.requiredManpower');

    // Column + composite-key migrations that depend on `stations` existing.
    // stationID uses a NOT NULL DEFAULT 0 sentinel (0 = "whole Line, no
    // specific station" = today's behavior) rather than NULL. That matters
    // for l2-4completedusers specifically: those tables rely on
    // "INSERT ... ON DUPLICATE KEY UPDATE" against a UNIQUE KEY to upsert
    // acknowledgements, and MySQL treats NULL <> NULL for uniqueness -
    // a nullable stationID would silently break that upsert (every
    // re-acknowledge of the same line would insert a new row instead of
    // updating the existing one). 0 behaves like a normal equal value, so
    // upserts keep working exactly as before for anything that doesn't
    // specify a station.
    safeAlter('ALTER TABLE subcourses ADD COLUMN stationID INT NOT NULL DEFAULT 0', 'subcourses.stationID');
    // Comma-separated list of uRole values (e.g. "Inspector,Trainee Operator")
    // that a Level 1 course is restricted to. NULL/empty = visible to every
    // role (the old, pre-existing behavior) - see /getViewscormCourseList.
    safeAlter('ALTER TABLE subcourses ADD COLUMN subCourseRoles VARCHAR(255) DEFAULT NULL', 'subcourses.subCourseRoles');
    safeAlter('ALTER TABLE enrollstatus ADD COLUMN stationID INT NOT NULL DEFAULT 0', 'enrollstatus.stationID');
    safeAlter('ALTER TABLE l1completedusers ADD COLUMN assignedStationID INT DEFAULT NULL', 'l1completedusers.assignedStationID');
    // NOTE: l2-4completedusers station migrations run separately, further
    // down, *after* ensureLevelCompletedUsersTable(2/3/4) creates those
    // tables - on a brand-new database those tables don't exist yet at this
    // point in the file, so ALTERing them here would silently no-op/fail.
  });
}

ensureStationsTable();

// Widens l2/l3/l4completedusers with a station-aware unique key. Must run
// after ensureLevelCompletedUsersTable(2/3/4) below has created those
// tables (see the ensureStationsTable ordering note above).
function ensureLevelCompletedUsersStationColumns() {
  [2, 3, 4].forEach(levelNum => {
    const tableName = `l${levelNum}completedusers`;
    safeAlter(`ALTER TABLE ${tableName} ADD COLUMN stationID INT NOT NULL DEFAULT 0`, `${tableName}.stationID`);
    // Widen the uniqueness key so a user can have independent Level N status
    // per Station, not just per Line. Widening (adding a column to an
    // existing unique key) can never conflict with rows that were already
    // unique under the narrower key.
    safeAlter(`ALTER TABLE ${tableName} DROP INDEX uniq_${tableName}_user_course`, `${tableName} drop old unique key`);
    safeAlter(
      `ALTER TABLE ${tableName} ADD UNIQUE KEY uniq_${tableName}_user_course_station (uniqueID, mCourseID, stationID)`,
      `${tableName} add station-aware unique key`
    );
  });
}

// Level 2 / 3 / 4 completed-users tables (Harman-style level-wise
// acknowledgement, same shape as l1completedusers but scoped to a specific
// Dept/Area/Process-Line, since Level 2+ courses live under a hierarchy
// rather than being global like Level 1). Bootstrapped the same way.
function ensureLevelCompletedUsersTable(levelNum) {
  const tableName = `l${levelNum}completedusers`;
  const statusCol = `l${levelNum}Status`;
  const query = `
    CREATE TABLE IF NOT EXISTS ${tableName} (
      id INT NOT NULL AUTO_INCREMENT,
      uniqueID INT NOT NULL,
      deptID INT DEFAULT NULL,
      areaID INT DEFAULT NULL,
      mCourseID INT DEFAULT NULL,
      levelStartDate DATE DEFAULT NULL,
      levelDate DATE DEFAULT NULL,
      ${statusCol} VARCHAR(20) DEFAULT NULL,
      acknowledgeDate DATETIME DEFAULT NULL,
      acknowledgedBy INT DEFAULT NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_${tableName}_user_course (uniqueID, mCourseID)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `;
  connection.query(query, (error) => {
    if (error) {
      console.error(`Error ensuring ${tableName} table:`, error);
      return;
    }
    console.log(`${tableName} table is ready`);
  });
}

ensureLevelCompletedUsersTable(2);
ensureLevelCompletedUsersTable(3);
ensureLevelCompletedUsersTable(4);
// Run the station-column/key migration after a short delay so it lands
// after the CREATE TABLE IF NOT EXISTS calls above have actually completed
// on a brand-new database (those are async; this app doesn't currently
// chain callbacks between these setup functions, so a small delay is the
// simplest safe fix consistent with how the rest of this file already
// bootstraps schema at startup).
setTimeout(ensureLevelCompletedUsersStationColumns, 1500);

// ---------------------------------------------------------------------------
// Practical Evaluation module (admin-only). New tables, new routes, new
// admin pages only - nothing here touches employee login, course-attempting,
// or SCORM-delivery code. See the Practical Evaluation routes further
// down (search "Practical Evaluation module (admin-only)") for the routes
// that use these tables.
// ---------------------------------------------------------------------------
function ensurePracticalEvaluationsTable() {
  const query = `
    CREATE TABLE IF NOT EXISTS practicalevaluations (
      practicalEvalID INT NOT NULL AUTO_INCREMENT,
      subCourseID INT NOT NULL,
      uniqueID INT NOT NULL,
      employeeCode VARCHAR(50) DEFAULT NULL,
      dateOfJoining DATE DEFAULT NULL,
      deptSegmentLine VARCHAR(255) DEFAULT NULL,
      mcProcess VARCHAR(255) DEFAULT NULL,
      ojtStartDate DATE DEFAULT NULL,
      ojtEndDate DATE DEFAULT NULL,
      evaluationStatus VARCHAR(20) NOT NULL DEFAULT 'Draft',
      day10Percent DECIMAL(5,2) DEFAULT NULL,
      day11Percent DECIMAL(5,2) DEFAULT NULL,
      day12Percent DECIMAL(5,2) DEFAULT NULL,
      day13Percent DECIMAL(5,2) DEFAULT NULL,
      day14Percent DECIMAL(5,2) DEFAULT NULL,
      day15Percent DECIMAL(5,2) DEFAULT NULL,
      wk3Percent DECIMAL(5,2) DEFAULT NULL,
      wk4Percent DECIMAL(5,2) DEFAULT NULL,
      totalScore DECIMAL(6,2) DEFAULT NULL,
      maxScoreApplicable DECIMAL(6,2) DEFAULT NULL,
      overallPercent DECIMAL(5,2) DEFAULT NULL,
      result VARCHAR(10) DEFAULT NULL,
      monitoringResult VARCHAR(10) DEFAULT NULL,
      finalScore DECIMAL(6,2) DEFAULT NULL,
      finalMaxScore DECIMAL(6,2) DEFAULT NULL,
      finalPercent DECIMAL(5,2) DEFAULT NULL,
      finalResult VARCHAR(10) DEFAULT 'Pending',
      submittedBy INT DEFAULT NULL,
      submittedAt DATETIME DEFAULT NULL,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (practicalEvalID),
      UNIQUE KEY uniq_practicaleval_course_user (subCourseID, uniqueID)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `;
  connection.query(query, (error) => {
    if (error) {
      console.error('Error ensuring practicalevaluations table:', error);
      return;
    }
    console.log('practicalevaluations table is ready');
  });
}

function ensurePracticalEvaluationsFinalColumns() {
  // Migration for installs created before the "final 4 column" pass/fail
  // requirement (day14, day15, wk3, wk4 only - day10-day13 are observation-
  // only and never mandatory). Safe to run repeatedly; ER_DUP_FIELDNAME is
  // expected once the columns exist.
  const query = `
    ALTER TABLE practicalevaluations
    ADD COLUMN finalScore DECIMAL(6,2) DEFAULT NULL,
    ADD COLUMN finalMaxScore DECIMAL(6,2) DEFAULT NULL,
    ADD COLUMN finalPercent DECIMAL(5,2) DEFAULT NULL,
    ADD COLUMN finalResult VARCHAR(10) DEFAULT 'Pending'
  `;
  connection.query(query, (error) => {
    if (!error) {
      console.log('practicalevaluations final-result columns are ready');
      return;
    }
    if (error.code === 'ER_DUP_FIELDNAME') {
      console.log('practicalevaluations final-result columns already exist');
      return;
    }
    console.error('Error adding practicalevaluations final-result columns:', error);
  });
}

function ensurePracticalEvaluationScoresTable() {
  const query = `
    CREATE TABLE IF NOT EXISTS practicalevaluationscores (
      id INT NOT NULL AUTO_INCREMENT,
      practicalEvalID INT NOT NULL,
      checkpointNo TINYINT NOT NULL,
      dayCode VARCHAR(10) NOT NULL,
      score TINYINT NOT NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_practicalscore_cell (practicalEvalID, checkpointNo, dayCode)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `;
  connection.query(query, (error) => {
    if (error) {
      console.error('Error ensuring practicalevaluationscores table:', error);
      return;
    }
    console.log('practicalevaluationscores table is ready');
  });
}

ensurePracticalEvaluationsTable();
ensurePracticalEvaluationsFinalColumns();
ensurePracticalEvaluationScoresTable();

// ---------------------------------------------------------------------------
// Admin-only "Course View" question bank persistence
// ---------------------------------------------------------------------------
// Historically, questions parsed from an uploaded assessment Excel file were
// only ever baked into a static {courseID}_quiz.html file (see
// generateQuizAndRespond in /uploadExcel and the matching block in
// /uploadTraining) - never stored as editable rows. This table persists those
// same rows (additively, alongside the existing static-file generation, which
// is left completely untouched) purely so the new admin Course View page can
// list/edit questions and regenerate the quiz file on save. It is never read
// by any employee-facing/course-attempting route.
function ensureSubcourseQuestionsTable() {
  const query = `
    CREATE TABLE IF NOT EXISTS subcourse_questions (
      questionID INT NOT NULL AUTO_INCREMENT,
      subCourseID INT NOT NULL,
      questionOrder INT NOT NULL DEFAULT 0,
      questionText LONGTEXT,
      questionImage VARCHAR(500) DEFAULT NULL,
      option1Text LONGTEXT,
      option1Image VARCHAR(500) DEFAULT NULL,
      option2Text LONGTEXT,
      option2Image VARCHAR(500) DEFAULT NULL,
      option3Text LONGTEXT,
      option3Image VARCHAR(500) DEFAULT NULL,
      option4Text LONGTEXT,
      option4Image VARCHAR(500) DEFAULT NULL,
      answerText VARCHAR(10) DEFAULT NULL,
      PRIMARY KEY (questionID),
      KEY idx_subcourse_questions_subCourseID (subCourseID)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `;
  connection.query(query, (error) => {
    if (error) {
      console.error('Error ensuring subcourse_questions table:', error);
      return;
    }
    console.log('subcourse_questions table is ready');
  });
}

ensureSubcourseQuestionsTable();

function ensureRefresherTables() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS refresher_subcourses (
      subCourseID int NOT NULL AUTO_INCREMENT,
      deptID int DEFAULT NULL,
      areaID int DEFAULT NULL,
      mCourseID int DEFAULT NULL,
      coMCourseID int DEFAULT NULL,
      subCourseName text,
      subCourseDescription text,
      subCourseDate text,
      subCourseTags text,
      subCourseTeacher text,
      subCourseLevel text,
      subCourseTeacherUniqueID text,
      subCoursePath text,
      subCourseRefreshDate date DEFAULT NULL,
      subCourseCompletionDate text,
      subCourseRevisionDate date DEFAULT NULL,
      subCourseRevisionNumber varchar(100) DEFAULT NULL,
      subCourseDocumentNo varchar(100) DEFAULT NULL,
      subCourseRemark text,
      subCourseIssueDate date DEFAULT NULL,
      subCourseDocAuthorised text,
      subCourseFormatNo varchar(100) DEFAULT NULL,
      practicalExam text,
      subCoursePassing int DEFAULT NULL,
      isOnlyTraining varchar(45) DEFAULT NULL,
      subcoursescol varchar(45) DEFAULT NULL,
      subCourseTeacher2 text,
      subCourseTeacher2UniqueID int DEFAULT NULL,
      duration time DEFAULT NULL,
      courseType enum('training','assessment','practical','ojt_observation','scorm') DEFAULT 'training',
      contentType enum('ppt','pdf','video','excel','scorm_zip','excel_with_ppt','video_with_excel','practical_template','observation_template') DEFAULT NULL,
      scormPath text,
      scormCourseID int DEFAULT NULL,
      scormManifestPath text,
      scormVersion varchar(45) DEFAULT NULL,
      scormLaunchFile text,
      mahindraOldCourseID int DEFAULT NULL,
      PRIMARY KEY (subCourseID),
      KEY idx_refresher_subcourses_type (courseType)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
    `CREATE TABLE IF NOT EXISTS refresher_courseattempts (
      attemptID int NOT NULL AUTO_INCREMENT,
      deptID int DEFAULT NULL,
      areaID int DEFAULT NULL,
      mCourseID int DEFAULT NULL,
      coMCourseID int DEFAULT NULL,
      subCourseID int DEFAULT NULL,
      uniqueID int DEFAULT NULL,
      noOfAttempts int DEFAULT NULL,
      pretestScore float DEFAULT NULL,
      score float DEFAULT NULL,
      status text,
      duration text,
      courseDate date DEFAULT NULL,
      courseTime time DEFAULT NULL,
      attemptRemark varchar(250) DEFAULT NULL,
      PRIMARY KEY (attemptID),
      KEY idx_refresher_attempt_user_course (uniqueID, subCourseID),
      KEY idx_refresher_attempt_remark (uniqueID, subCourseID, attemptRemark)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
    `CREATE TABLE IF NOT EXISTS refresher_attempts_items (
      id bigint NOT NULL AUTO_INCREMENT,
      attemptID int DEFAULT NULL,
      deptID int DEFAULT NULL,
      areaID int DEFAULT NULL,
      mCourseID int DEFAULT NULL,
      coMCourseID int DEFAULT NULL,
      subCourseID int DEFAULT NULL,
      questionText mediumtext,
      optionAText text,
      optionBText text,
      optionCText text,
      optionDText text,
      practicalAnswer text,
      userAnswer text,
      isCorrect int DEFAULT NULL,
      PRIMARY KEY (id),
      KEY idx_refresher_items_attempt (attemptID),
      KEY idx_refresher_items_subcourse (subCourseID)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
    `CREATE TABLE IF NOT EXISTS refresher_coursegrades (
      id int NOT NULL AUTO_INCREMENT,
      deptID int DEFAULT NULL,
      areaID int DEFAULT NULL,
      mCourseID int DEFAULT NULL,
      coMCourseID int DEFAULT NULL,
      subCourseID int DEFAULT NULL,
      uniqueID int DEFAULT NULL,
      attemptID int DEFAULT NULL,
      noOfAttempts int DEFAULT NULL,
      pretestScore float DEFAULT NULL,
      score float DEFAULT NULL,
      status text,
      duration text,
      courseDate text,
      courseTime text,
      trainerUniqueID int DEFAULT NULL,
      PRIMARY KEY (id),
      KEY idx_refresher_grades_user_course (uniqueID, subCourseID),
      KEY idx_refresher_grades_attempt (attemptID)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
    `CREATE TABLE IF NOT EXISTS refresher_traininggrades (
      id int NOT NULL AUTO_INCREMENT,
      deptID int DEFAULT NULL,
      areaID int DEFAULT NULL,
      mCourseID int DEFAULT NULL,
      coMCourseID int DEFAULT NULL,
      subCourseID int DEFAULT NULL,
      uniqueID int DEFAULT NULL,
      noOfAttemptss int DEFAULT NULL,
      pretestScore float DEFAULT NULL,
      score float DEFAULT NULL,
      status text,
      duration int DEFAULT NULL,
      courseDate text,
      courseTime text,
      trainerUniqueID int DEFAULT NULL,
      PRIMARY KEY (id),
      KEY idx_refresher_training_user_course (uniqueID, subCourseID)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
    `CREATE TABLE IF NOT EXISTS skillmatrix_refresher_assignments (
      id int NOT NULL AUTO_INCREMENT,
      uniqueID int NOT NULL,
      deptID int NOT NULL,
      areaID int NOT NULL,
      mCourseID int NOT NULL,
      stationID int NOT NULL DEFAULT 0,
      planMonth tinyint NOT NULL,
      planYear int NOT NULL,
      plannedDate date DEFAULT NULL,
      planCode varchar(10) NOT NULL DEFAULT 'RT',
      status varchar(30) NOT NULL DEFAULT 'Planned',
      createdAt datetime DEFAULT CURRENT_TIMESTAMP,
      updatedAt datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_skillmatrix_refresher_plan (uniqueID, deptID, areaID, mCourseID, stationID, planMonth, planYear),
      KEY idx_skillmatrix_refresher_user (uniqueID),
      KEY idx_skillmatrix_refresher_line (deptID, areaID, mCourseID, stationID)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
    `CREATE TABLE IF NOT EXISTS skillmatrix_station_skills (
      id int NOT NULL AUTO_INCREMENT,
      uniqueID int NOT NULL,
      deptID int NOT NULL,
      areaID int NOT NULL,
      mCourseID int NOT NULL,
      stationID int NOT NULL,
      requiredLevel tinyint NOT NULL DEFAULT 2,
      createdAt datetime DEFAULT CURRENT_TIMESTAMP,
      updatedAt datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_skillmatrix_station_skill (uniqueID, deptID, areaID, mCourseID, stationID),
      KEY idx_skillmatrix_station_skill_user (uniqueID),
      KEY idx_skillmatrix_station_skill_line (deptID, areaID, mCourseID, stationID)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`
  ];

  statements.forEach(statement => {
    connection.query(statement, (error) => {
      if (error) {
        console.error('Error ensuring refresher table:', error);
      }
    });
  });

  connection.query(
    `ALTER TABLE skillmatrix_refresher_assignments ADD COLUMN planCode varchar(10) NOT NULL DEFAULT 'RT' AFTER plannedDate`,
    (error) => {
      if (error && error.code !== 'ER_DUP_FIELDNAME') {
        console.error('Error ensuring skillmatrix_refresher_assignments.planCode:', error);
      }
    }
  );
}

ensureRefresherTables();

function insertRefresherSubcourseFromUpload(courseData, uploadPath, courseType, contentType, callback) {
  const numericCourseID = Number(courseData.courseID);
  const legacyCourseID =
    Number.isInteger(numericCourseID) && numericCourseID > 0 && numericCourseID <= 2147483647
      ? numericCourseID
      : null;
  const isScormCourse = contentType === 'scorm_zip';
  const refreshalDate = calculateRefreshalDate(courseData.courseDate, courseData.RT_Date);
  const query = `
    INSERT INTO refresher_subcourses
      (deptID, areaID, mCourseID, coMCourseID, subCourseName, subCourseDescription, subCourseDate,
       subCourseTeacher, subCourseLevel, subCoursePath, subCourseRefreshDate, subCoursePassing,
       isOnlyTraining, practicalExam, courseType, contentType, scormPath, scormCourseID, mahindraOldCourseID)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  connection.query(
    query,
    [
      null,
      null,
      null,
      null,
      courseData.courseName,
      courseData.courseDescription,
      courseData.courseDate,
      courseData.courseTeacher || null,
      'Refresher',
      uploadPath,
      refreshalDate,
      courseData.subCoursePassing || courseData.passing || null,
      courseType === 'training' ? 'yes' : null,
      courseType,
      courseType,
      contentType,
      isScormCourse ? uploadPath : null,
      isScormCourse ? legacyCourseID : null,
      legacyCourseID,
    ],
    callback
  );
}

// Persists the same question rows used to build the static quiz HTML into
// subcourse_questions, so the admin Course View page has something to show.
// Best-effort: failures are logged only and never affect the upload response,
// since the static quiz file (the thing employees actually use) is already
// written by the time this runs.
function persistSubcourseQuestions(subCourseID, jsonDataRows) {
  if (!subCourseID || !Array.isArray(jsonDataRows) || !jsonDataRows.length) return;
  const rows = jsonDataRows.map((row, index) => [
    subCourseID,
    index + 1,
    row.questionText != null ? String(row.questionText) : null,
    row.option1Text != null ? String(row.option1Text) : null,
    row.option2Text != null ? String(row.option2Text) : null,
    row.option3Text != null ? String(row.option3Text) : null,
    row.option4Text != null ? String(row.option4Text) : null,
    row.answerText != null ? String(row.answerText).trim().toUpperCase() : null,
  ]);
  const insertQuery = `
    INSERT INTO subcourse_questions
      (subCourseID, questionOrder, questionText, option1Text, option2Text, option3Text, option4Text, answerText)
    VALUES ?
  `;
  connection.query(insertQuery, [rows], (error) => {
    if (error) {
      console.error('Error persisting subcourse_questions (non-fatal):', error);
    }
  });
}

// Rebuilds {courseID}_quiz.html in place from subcourse_questions, using the
// exact same template/markup shape as generateQuizAndRespond so the existing
// employee-facing /training/:courseID route (which just serves this static
// file - untouched) keeps working, now reflecting admin edits.
function regenerateQuizHTMLFromQuestions(courseID, courseName, coursePath, questionRows, callback) {
  const templatePath = path.join(__dirname, 'public', 'trainingAss_Template.html');
  let template;
  try {
    template = fs.readFileSync(templatePath, 'utf-8');
  } catch (err) {
    return callback(err);
  }

  const escapeAttr = (text) => String(text == null ? '' : text).replace(/"/g, '&quot;');
  const escapeHTML = (text) => String(text == null ? '' : text);

  let quizQuestions = '';
  questionRows.forEach((row, index) => {
    const answerKey = {
      A: row.option1Text,
      B: row.option2Text,
      C: row.option3Text,
      D: row.option4Text,
    };
    const correctAnswerText = answerKey[String(row.answerText || '').trim().toUpperCase()];

    quizQuestions += `
      <div class="question" data-question-number="${index + 1}" data-correct-answer="${escapeAttr(correctAnswerText)}">
          <p><strong>${index + 1}. ${escapeHTML(row.questionText)}</strong></p>
          <label><input type="radio" name="question${index}" value="${escapeAttr(row.option1Text)}"> ${escapeHTML(row.option1Text)}</label><br>
          <label><input type="radio" name="question${index}" value="${escapeAttr(row.option2Text)}"> ${escapeHTML(row.option2Text)}</label><br>
          <label><input type="radio" name="question${index}" value="${escapeAttr(row.option3Text)}"> ${escapeHTML(row.option3Text)}</label><br>
          <label><input type="radio" name="question${index}" value="${escapeAttr(row.option4Text)}"> ${escapeHTML(row.option4Text)}</label><br>
      </div>
    `;
  });

  const finalQuizHTML = template
    .replace(/{{courseName}}/g, courseName || '')
    .replace(/{{courseID}}/g, courseID)
    .replace(/{{quizQuestions}}/g, quizQuestions);

  try {
    if (!fs.existsSync(coursePath)) {
      fs.mkdirSync(coursePath, { recursive: true });
    }
    const htmlFilePath = path.join(coursePath, `${courseID}_quiz.html`);
    fs.writeFileSync(htmlFilePath, finalQuizHTML);
    callback(null, htmlFilePath);
  } catch (err) {
    callback(err);
  }
}

const missingNormalizedSchemaCodes = new Set([
  'ER_NO_SUCH_TABLE',
  'ER_BAD_FIELD_ERROR',
  'ER_PARSE_ERROR',
]);

function shouldFallbackToLegacySchema(error) {
  return error && missingNormalizedSchemaCodes.has(error.code);
}

function normalizedCourseListQuery(whereClause = '', orderClause = 'ORDER BY sc.subCourseID DESC') {
  return `
    SELECT
      sc.subCourseID AS id,
      sc.subCourseName AS courseName,
      sc.subCourseDate AS courseDate,
      sc.subCourseDescription AS courseDescription,
      sc.subCourseTeacher AS courseTeacher,
      COALESCE(sc.scormPath, sc.subCoursePath) AS scormPath,
      sc.subCourseID AS courseID,
      sc.subCourseLevel AS level,
      sc.deptID,
      sc.areaID,
      sc.mCourseID,
      sc.coMCourseID,
      d.deptName AS departmentName,
      a.areaName,
      m.mCourseName,
      co.coMCourseName,
      sc.courseType,
      sc.contentType,
      sc.subCoursePassing,
      sc.subCourseRoles
    FROM subcourses sc
    LEFT JOIN departments d ON d.deptID = sc.deptID
    LEFT JOIN areas a ON a.areaID = sc.areaID
    LEFT JOIN mcourses m ON m.mCourseID = sc.mCourseID
    LEFT JOIN comaincourses co ON co.coMCourseID = sc.coMCourseID
    ${whereClause}
    ${orderClause}
  `;
}

function sendLegacyOrNormalizedCourseList(res, normalizedSql, normalizedParams, legacySql, legacyParams = []) {
  connection.query(normalizedSql, normalizedParams, (error, results) => {
    if (!error) {
      return res.json(results);
    }

    if (!shouldFallbackToLegacySchema(error)) {
      console.error('Error fetching normalized course list:', error);
      return res.status(500).send('Internal Server Error');
    }

    connection.query(legacySql, legacyParams, (legacyError, legacyResults) => {
      if (legacyError) {
        console.error('Error fetching legacy course list:', legacyError);
        return res.status(500).send('Internal Server Error');
      }

      res.json(legacyResults);
    });
  });
}

// Accepts an array (from checkboxes serialized as subCourseRoles[]), a
// comma-separated string, or nothing, and normalizes to either a trimmed
// comma-separated string or null (null/empty = visible to every role, the
// backward-compatible default for every course that existed before this
// feature). See /getViewscormCourseList for the read side.
function normalizeSubCourseRoles(rawRoles) {
  let roles = rawRoles;
  if (typeof roles === 'string') {
    roles = roles.split(',');
  }
  if (!Array.isArray(roles)) {
    return null;
  }
  const cleaned = roles
    .map(role => String(role || '').trim())
    .filter(Boolean);
  return cleaned.length ? cleaned.join(',') : null;
}

function insertNormalizedSubcourseFromUpload(courseData, uploadPath, courseType, contentType, callback) {
  const mCourseID = courseData.mCourseID || courseData.processID || courseData.processLineID;
  // Level 1 courses are standalone: no Department / Segment / Process-Line is
  // assigned, so they are visible to every learner without any enrollment
  // (see /getViewscormCourseList). Callers opt into this by explicitly setting
  // courseData.skipHierarchy = true (see /uploadTrainingMaterial and /uploadExcel
  // when req.body.level1 is set) - this never triggers for the existing,
  // unmodified Level 2+ upload path.
  const isStandaloneLevel1Course = !mCourseID && courseData.skipHierarchy === true;
  // Common courses: Level 2/3/4 content with no Department/Segment/Process/Station
  // at all - visible to every learner who has ANY active Level 2+ enrollment,
  // regardless of which Line/Station they're on (see /getViewscormCourseList).
  const isCommonCourse = !mCourseID && courseData.isCommon === true;
  const isStandaloneCourse = isStandaloneLevel1Course || isCommonCourse;

  if (!mCourseID && !isStandaloneCourse) {
    return callback(null, null, false);
  }
  const isScormCourse = contentType === 'scorm_zip';
  const numericCourseID = Number(courseData.courseID);
  const legacyCourseID =
    Number.isInteger(numericCourseID) && numericCourseID > 0 && numericCourseID <= 2147483647
      ? numericCourseID
      : null;

  // stationID 0 = whole-Line (same convention as everywhere else in the
  // Station rollout - Level 1 courses and anything uploaded without a
  // station stay visible/scoped exactly as before).
  const resolvedStationID = isStandaloneCourse ? 0 : (Number(courseData.stationID) || 0);

  const insertCourse = (line, coMCourseID) => {
    const refreshalDate = calculateRefreshalDate(courseData.courseDate, courseData.RT_Date);
    const query = `
      INSERT INTO subcourses
        (deptID, areaID, mCourseID, stationID, coMCourseID, subCourseName, subCourseDescription, subCourseDate,
         subCourseTeacher, subCourseLevel, subCoursePath, subCourseRefreshDate, subCoursePassing,
         isOnlyTraining, courseType, contentType, scormPath, scormCourseID, mahindraOldCourseID, subCourseRoles)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    // Only meaningful for standalone Level 1 courses (see /getViewscormCourseList) -
    // harmless to store for other levels since nothing else reads it there yet.
    const normalizedRoles = normalizeSubCourseRoles(courseData.subCourseRoles);

    connection.query(
      query,
      [
        line.deptID,
        line.areaID,
        line.mCourseID,
        resolvedStationID,
        coMCourseID,
        courseData.courseName,
        courseData.courseDescription,
        courseData.courseDate,
        courseData.courseTeacher || null,
        courseData.level || courseData.subCourseLevel || null,
        uploadPath,
        refreshalDate,
        courseData.subCoursePassing || courseData.passing || null,
        courseType === 'training' ? 'yes' : null,
        courseType,
        contentType,
        isScormCourse ? uploadPath : null,
        isScormCourse ? legacyCourseID : null,
        legacyCourseID,
        normalizedRoles,
      ],
      (insertError, result) => callback(insertError, result, true)
    );
  };

  if (isStandaloneCourse) {
    insertCourse({ deptID: null, areaID: null, mCourseID: null }, null);
    return;
  }

  const lineQuery = `
    SELECT m.mCourseID, m.deptID, m.areaID, m.mCourseName, co.coMCourseID
    FROM mcourses m
    LEFT JOIN comaincourses co
      ON co.mCourseID = m.mCourseID
     AND co.isDefaultForLine = 1
    WHERE m.mCourseID = ?
    ORDER BY co.coMCourseID
    LIMIT 1
  `;

  connection.query(lineQuery, [mCourseID], (lineError, lineRows) => {
    if (lineError) {
      return callback(lineError);
    }

    if (!lineRows.length) {
      const notFound = new Error('Process/Line not found');
      notFound.code = 'PROCESS_NOT_FOUND';
      return callback(notFound);
    }

    const line = lineRows[0];

    if (line.coMCourseID) {
      insertCourse(line, line.coMCourseID);
      return;
    }

    createDefaultComainCourseForLine(line, (defaultError, defaultResult) => {
      if (defaultError) {
        return callback(defaultError);
      }
      insertCourse(line, defaultResult.insertId);
    });
  });
}


// Serve static files (like index.html)
// index: false stops it from auto-serving public/index.html at "/" —
// that was shadowing the app.get('/') route below, which serves home.html
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Second Skill Matrix entry requested by the client. Serve the same source
// file under a separate URL so both pages always retain identical routes,
// behavior and future fixes without creating a stale copied implementation.
app.get('/skillMatrix2.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'skillMatrix.html'));
});

// Historical/offline learners need an explicit marker so reports can keep
// their imported training separate from attempts made in the LMS. The course
// ID list preserves the import boundary: courses created later are not
// silently treated as failed for these learners.
function ensurePreviousUserColumns() {
  ['isPreviousUser TINYINT(1) NOT NULL DEFAULT 0', 'previousCourseIDs TEXT DEFAULT NULL']
    .forEach(definition => connection.query(`ALTER TABLE users ADD COLUMN ${definition}`, error => {
      if (!error || error.code === 'ER_DUP_FIELDNAME') return;
      console.error('Error ensuring previous-user column:', error.message);
    }));
}

ensurePreviousUserColumns();

function previousCourseIDSet(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return new Set(Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : []);
  } catch (_) {
    return new Set();
  }
}

// Serve specific SCORM package content based on selected folder
app.use('/scorm/:folderName', express.static(path.join(__dirname, 'uploads')));

// Adding new line for training video
app.use("/uploads", express.static(path.join(__dirname, "uploads")));


// Serve extracted SCORM content statically
app.use('/scorm', express.static(path.join(__dirname, 'uploads')));

app.use('/js', express.static(path.join(__dirname, 'public/js')));

// Serve home.html for the root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'home.html'));
});



// Serve index.html for both root and "/courses" routes
app.get(['/courses'], (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

//app.set('view engine', 'ejs');


//User information upload
const storage = multer.diskStorage({
  destination: path.join(__dirname, 'public/photos'),
  filename: (req, file, callback) => {
    // Use the filename already created by the frontend
    callback(null, file.originalname);
  }
});

const uploadMysql = multer({ storage: storage });



// Set up storage for uploaded files in 'Excel Assessment' folder
const uploadExcelAssessment = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, "Excel Assessment");
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  },
});

const uploadExcelAss = multer({ storage: uploadExcelAssessment });



const uploadExcelTrainingAssStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, "Training Assessment", "Pretest assessment");
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  },
});

const uploadExcelTrainingAss = multer({ storage: uploadExcelTrainingAssStorage });

const uploadVideoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const videoDir = path.join(__dirname, "uploads", "Training Assessment", "Videos");
    if (!fs.existsSync(videoDir)) {
      fs.mkdirSync(videoDir, { recursive: true });
    }
    cb(null, videoDir);
  },
  filename: (req, file, cb) => {
    const { courseID } = req.body;
    cb(null, `${courseID}_video`);
  },
});

const uploadVideo = multer({ storage: uploadVideoStorage });


const uploadFiles = multer().fields([
  { name: "mcqFile", maxCount: 1 },
  { name: "videoFile", maxCount: 1 },
  { name: "pptFile", maxCount: 1 },
  { name: "trainingFile", maxCount: 1 },
  { name: "trainingFile1", maxCount: 1 },
  { name: "trainingFile2", maxCount: 1 },
  { name: "trainingFile3", maxCount: 1 },
  { name: "mcqFile1", maxCount: 1 }, { name: "mcqFile2", maxCount: 1 }, { name: "mcqFile3", maxCount: 1 },
  { name: "supportFile1", maxCount: 1 }, { name: "supportFile2", maxCount: 1 }, { name: "supportFile3", maxCount: 1 },
]);

// One training course can have up to three language-specific files while
// completion remains tied to the original subCourseID.
function ensureTrainingMaterialLanguagesTable() {
  connection.query(
    `CREATE TABLE IF NOT EXISTS training_material_languages (
      id INT NOT NULL AUTO_INCREMENT,
      subCourseID INT NOT NULL,
      courseSource VARCHAR(20) NOT NULL DEFAULT 'regular',
      languageName VARCHAR(80) NOT NULL,
      filePath TEXT NOT NULL,
      contentType VARCHAR(20) NOT NULL,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_training_language (subCourseID, courseSource, languageName)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
    (error) => {
      if (error) console.error('Error ensuring training material languages table:', error);
    }
  );
}
ensureTrainingMaterialLanguagesTable();

app.get('/presentationindex.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'presentationindex.html'));
});


// app.post('/save-details', async (req, res) => {
//   let { name, emailID, employeeID, uName, uPass, dateOfJoining, dateOfBirth, address, mobileNo, department, Contract, uRole, courseTags, Qualification } = req.body;

//   const uniqueID = uuidv4(); 

//   // --- CRITICAL CHANGE 4: Get the filename from the request body ---
//   const photoFileName = req.body.photoFileName || 'default.png'; // Use the filename passed from the frontend
//   const photo_filename = path.join(__dirname, 'public', 'photos', photoFileName); // This is correct, but the variable is now 'photoFileName'

//   console.log(Qualification);
//   const myCurrentDate = new Date().toLocaleDateString('en-GB', {});
//   const myCurrentTime = new Date().toLocaleTimeString('en-US', {});
//   const userInfo = { uniqueID, employeeID, name }; 

//   try {
//     // Step 1: Insert user data into the main user table
//     await connection.promise().query(
//       // --- CRITICAL CHANGE 5: Replace the undefined 'fileName' with 'photoFileName' ---
//       'INSERT INTO users (id, uniqueID, name, emailID, employeeID, uName, uPass, dateOfJoining, dateOfBirth, address, mobileNo, department, uRole, photo, photo_filename, currentDate, currentTime, courseTags,Contract ,Qualification) VALUES (NULL, ?, ?,?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,?)',
//       [uniqueID, name, emailID, employeeID, uName, uPass, dateOfJoining, dateOfBirth, address, mobileNo, department, uRole, photoFileName, photo_filename, myCurrentDate, myCurrentTime, JSON.stringify(courseTags), Contract, Qualification]
//       //                                                                                         ^ Change this to photoFileName
//     );
//     // ... (rest of the code is fine) ...
//   } catch (error) {
//     console.error('Error saving user and course data:', error);
//     res.status(500).json({ error: 'An error occurred while saving user and course data' });
//   }
// });




app.post('/save-details', async (req, res) => {
  let {
    uniqueID, name, emailID, employeeID, uName, uPass, dateOfJoining, dateOfBirth,
    address, mobileNo, department, Contract, uRole, Qualification
  } = req.body;

  const requestedUniqueID = Number.isInteger(Number(uniqueID)) && Number(uniqueID) > 0
    ? Number(uniqueID)
    : null;

  const selectedTags = req.body['courseTags[]'] || req.body.courseTags || req.body.level || [];
  const userTags = Array.isArray(selectedTags) ? selectedTags.join(',') : selectedTags;
  const photoFileName = req.body.photoFileName || 'default.png';
  const photoPath = `/photos/${photoFileName}`;

  if (!String(uName || '').trim() || !String(uPass || '').trim()) {
    return res.status(400).json({ error: 'User ID and Password are required for learner login' });
  }

  const myCurrentDate = new Date().toLocaleDateString('en-GB', {});
  const myCurrentTime = new Date().toLocaleTimeString('en-US', {});

  try {
    const columns = requestedUniqueID
      ? '(uniqueID, name, emailID, employeeID, uName, uPass, photo, photoPath, dateOfJoining, dateOfBirth, address, mobileNo, department, uRole, registerDate, registerTime, qualification, contract, userTags)'
      : '(name, emailID, employeeID, uName, uPass, photo, photoPath, dateOfJoining, dateOfBirth, address, mobileNo, department, uRole, registerDate, registerTime, qualification, contract, userTags)';
    const values = [
      ...(requestedUniqueID ? [requestedUniqueID] : []),
      name, emailID, employeeID, uName, uPass, photoFileName, photoPath,
      dateOfJoining, dateOfBirth, address, mobileNo, department, uRole,
      myCurrentDate, myCurrentTime, Qualification, Contract, userTags
    ];
    const [result] = await connection.promise().query(
      `INSERT INTO users ${columns} VALUES (${values.map(() => '?').join(', ')})`,
      values
    );

    res.json({
      success: true,
      message: "User uploaded successfully!",
      uploadedUser: { uniqueID: requestedUniqueID || result.insertId, employeeID, name, photoFileName }
    });

  } catch (error) {
    console.error('Error saving user and course data:', error);
    res.status(500).json({ error: 'An error occurred while saving user and course data' });
  }
});


app.post('/save-photo', uploadMysql.single('photo'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No photo uploaded' });
  }
  console.log('Photo uploaded successfully:', req.file.filename);
  res.status(200).json({ success: true, filename: req.file.filename });
});






// NOTE: legacy '/sign-up' route removed (it referenced columns/tables that no longer exist
// in the normalized schema: id, level JSON, photo_filename, course_<id> tables). It was dead
// code — addUser.html only ever called '/save-details' (manual add) and '/save-photo'.
// Bulk add now goes through '/upload-bulk-users' + '/confirm-bulk-users' below.






// Query to get course IDs where courseTags match any of the selected tags
/*const getCoursesQuery = `
  SELECT courseID 
  FROM courses 
  WHERE FIND_IN_SET('Safety', courseTags) > 0 
    OR FIND_IN_SET('Development', courseTags) > 0
`;

// Adjust the query dynamically to include all selected courseTags
const selectedTags = courseTags.map(tag => `FIND_IN_SET('${tag}', courseTags) > 0`).join(' OR ');
const getCoursesQueryUpdate = `
  SELECT courseID 
  FROM courses 
  WHERE ${selectedTags}
`;

// Execute the query to get matching course IDs
connection.query(getCoursesQueryUpdate, (err, results) => {
  if (err) {
    console.error("Error fetching course IDs:", err);
    return res.status(500).send("Error retrieving courses");
  }
  const courseIDs = results.map(row => row.courseID);

  // Pass courseIDs to the next step for adding user info
  insertUserToCourseTables(courseIDs);
});*/






// Endpoint to verify username uniqueness
app.post('/verify-username', (req, res) => {
  const { uName } = req.body;

  const query = 'SELECT COUNT(*) AS count FROM users WHERE uName = ?';
  connection.query(query, [uName], (err, result) => {
    if (err) {
      console.error(err);
      res.status(500).json({ error: 'Database query failed' });
    } else {
      const count = result[0].count;
      if (count > 0) {
        res.json({ exists: true });
      } else {
        res.json({ exists: false });
      }
    }
  });
});




//route for the verifyint the name of user

app.post('/verify-name', (req, res) => {
  console.log('Received name:', req.body.name);
  const { name } = req.body;

  const query = 'SELECT COUNT(*) AS count FROM users WHERE name = ?';
  connection.query(query, [name], (err, result) => {
    if (err) {
      console.error(err);
      res.status(500).json({ error: 'Database query failed' });
    } else {
      const count = result[0].count;
      if (count > 0) {
        res.json({ exists: true });
      } else {
        res.json({ exists: false });
      }
    }
  });
});







// Route to fetch course tags
app.get('/get-course-tags', (req, res) => {
  const query = 'SELECT DISTINCT level FROM courses';
  connection.query(query, (error, results) => {
    if (error) {
      console.error('Error fetching course tags:', error);
      res.status(500).json({ error: 'Internal server error' });
    } else {
      let tags = [];
      results.forEach(row => {
        if (row.level) { // Check if courseTags is not null
          const rowTags = row.level.split(',').map(tag => tag.trim());
          tags = tags.concat(rowTags);
        }
      });
      tags = [...new Set(tags)]; // Remove duplicates
      res.json(tags);
    }
  });
});





// Upload Scorm to inject js files
// Recursively find a file by name inside a directory
async function findFileRecursive(rootDir, targetName) {
  const entries = await fs.promises.readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      const result = await findFileRecursive(fullPath, targetName);
      if (result) return result;
    } else if (entry.isFile() && entry.name.toLowerCase() === targetName.toLowerCase()) {
      return fullPath;
    }
  }
  return null;
}

// Inject the two script tags into <head> of index_lms.html (if not already present)
async function injectScriptsIntoIndexLms(indexPath) {
  let html = await fs.promises.readFile(indexPath, 'utf8');

  // Don’t double-inject
  if (html.includes('universalScormDebugger.js') || html.includes('retrieveScormData.js')) {
    console.log('Scripts already present in:', indexPath);
    return;
  }

  const block = `
  <script src="universalScormDebugger.js"></script>
  <script src="./retrieveScormData.js"></script>
`;

  const match = html.match(/<head[^>]*>/i);
  if (match) {
    html = html.replace(match[0], match[0] + block);
  } else {
    // Fallback if <head> not found (rare in SCORM)
    html = block + html;
  }

  await fs.promises.writeFile(indexPath, html, 'utf8');
  console.log('Injected scripts into:', indexPath);
}



// Upload the scorm on the lms
// Upload the scorm on the lms
const uploadScormLanguages = upload.fields([
  { name: 'scormFile', maxCount: 1 }, { name: 'scormFile1', maxCount: 1 },
  { name: 'scormFile2', maxCount: 1 }, { name: 'scormFile3', maxCount: 1 }
]);
app.post('/upload', uploadScormLanguages, async (req, res) => {
  try {
    const scormVariants = [1, 2, 3].map(slot => {
      const file = req.files?.[`scormFile${slot}`]?.[0];
      const language = String(req.body[`language${slot}`] || '').trim();
      return file && language ? { file, language: safeTrainingLanguageFolder(language) } : null;
    }).filter(Boolean);
    const legacyFile = req.files?.scormFile?.[0];
    if (!scormVariants.length && legacyFile) scormVariants.push({ file: legacyFile, language: 'English' });
    if (!scormVariants.length) {
      return res.status(400).send('No file uploaded.');
    }
    if (new Set(scormVariants.map(v => v.language.toLowerCase())).size !== scormVariants.length) {
      return res.status(400).send('Each SCORM package must use a different language.');
    }

    // We keep the relative path SAME as before for DB: "uploads/Scorm_123456789"
    const scormFolderName = `Scorm_${Date.now()}`;
    const courseRootPath = path.join('uploads', scormFolderName);
    const uploadPath = `${courseRootPath.replace(/\\/g, '/')}/${scormVariants[0].language}`;
    const uploadAbsPath = path.join(__dirname, courseRootPath);

    fs.mkdirSync(uploadAbsPath, { recursive: true }); // Create a directory for the uploaded SCORM

    // Extract the SCORM content to the specific folder (absolute path)
    for (const variant of scormVariants) {
      const variantExtractPath = path.join(uploadAbsPath, variant.language);
      fs.mkdirSync(variantExtractPath, { recursive: true });
      new AdmZip(variant.file.path).extractAllTo(variantExtractPath, true);
      variant.uploadPath = `${courseRootPath.replace(/\\/g, '/')}/${variant.language}`;
      console.log(`${variant.language} SCORM extracted to:`, variantExtractPath);
    }
    const extractPath = path.join(uploadAbsPath, scormVariants[0].language);

    // --- NEW PART: copy JS files from public/js into the SCORM folder ---
    try {
      const jsBasePath = path.join(__dirname, 'public', 'js');
      const retrieveScormSrc = path.join(jsBasePath, 'retrieveScormData.js');
      const universalDebuggerSrc = path.join(jsBasePath, 'universalScormDebugger.js');

      if (!fs.existsSync(retrieveScormSrc) || !fs.existsSync(universalDebuggerSrc)) {
        console.warn('One or both JS files not found in public/js. Skipping copy.');
      } else {
        await fs.promises.copyFile(retrieveScormSrc, path.join(extractPath, 'retrieveScormData.js'));
        await fs.promises.copyFile(universalDebuggerSrc, path.join(extractPath, 'universalScormDebugger.js'));
        console.log('Copied retrieveScormData.js and universalScormDebugger.js into SCORM folder.');
      }

      // Find index_lms.html inside the extracted SCORM
      const indexLmsPath = await findFileRecursive(extractPath, 'index_lms.html');
      if (indexLmsPath) {
        await injectScriptsIntoIndexLms(indexLmsPath);
      } else {
        console.log('index_lms.html not found inside SCORM package.');
      }
    } catch (jsErr) {
      // Do NOT crash the upload – just log
      console.error('Error while copying JS or injecting scripts:', jsErr);
    }

    // Prepare the remaining language packages with the same SCORM bridge.
    for (const variant of scormVariants.slice(1)) {
      try {
        const variantPath = path.join(uploadAbsPath, variant.language);
        const jsBasePath = path.join(__dirname, 'public', 'js');
        await fs.promises.copyFile(path.join(jsBasePath, 'retrieveScormData.js'), path.join(variantPath, 'retrieveScormData.js'));
        await fs.promises.copyFile(path.join(jsBasePath, 'universalScormDebugger.js'), path.join(variantPath, 'universalScormDebugger.js'));
        const indexLmsPath = await findFileRecursive(variantPath, 'index_lms.html');
        if (indexLmsPath) await injectScriptsIntoIndexLms(indexLmsPath);
      } catch (variantError) {
        console.error(`Error preparing ${variant.language} SCORM package:`, variantError);
      }
    }

    // --- Existing logic continues as it is ---

    // Extract course data from the request body
    let { courseName, courseDescription, courseDate, courseID, level, mCourseName, RT_Date } = req.body;

    // Level 1 Management flow (see public/index.html) - same standalone/no-hierarchy
    // handling as /uploadExcel and /uploadTrainingMaterial.
    const isLevel1 = String(req.body.level1 || '').trim() === '1';
    // Refresher course flow (see public/index.html + refresherCourses.html) - same
    // standalone/no-hierarchy handling as /uploadExcel and /uploadTrainingMaterial.
    const isRefresher = String(req.body.refresher || '').trim() === '1';
    // Common Level 2/3/4 course flow (see public/index.html + commonCourses.html) -
    // only set when arriving via the Common Courses "+ Practical/SCORM" flow;
    // the normal Level 2+ SCORM upload (no flags) is completely unaffected.
    const isCommon = String(req.body.isCommon || '').trim() === '1';

    if (isLevel1) {
      level = 'Level 1';
    } else if (isRefresher) {
      level = 'Refresher';
    } else if (!level || level.trim() === '') {
      // Set courseTags to "default" if it is not provided
      level = 'default';
    }
    const refreshalMonths = RT_Date;
    RT_Date = calculateRefreshalDate(courseDate, refreshalMonths);

    if (RT_Date) {
      console.log(`Calculated RT_Date: ${RT_Date} (${refreshalMonths} months from ${courseDate})`);
    }

    if (isRefresher) {
      return insertRefresherSubcourseFromUpload(
        { ...req.body, courseName, courseDescription, courseDate, courseID, level, RT_Date: refreshalMonths },
        uploadPath,
        'scorm',
        'scorm_zip',
        (refresherError, refresherResult) => {
          if (refresherError) {
            console.error('Error saving refresher SCORM course:', refresherError);
            return res.status(500).send(refresherError.message || 'Error saving refresher course');
          }
          console.log('Refresher SCORM course saved to refresher_subcourses:', refresherResult.insertId);
          saveTrainingLanguageRows(refresherResult.insertId, 'refresher', scormVariants, 'scorm_zip', error => {
            if (error) console.error('Error registering refresher SCORM languages:', error);
          });
          const script = `
            <script>
              const uploadConfirmation = confirm('SCORM course uploaded successfully. Click OK to return to the upload page.');
              if (uploadConfirmation) {
                window.location.href = '/refresherCourses.html';
              }
            </script>
          `;
          return res.send(script);
        }
      );
    }

    insertNormalizedSubcourseFromUpload(
      { ...req.body, courseName, courseDescription, courseDate, courseID, level, mCourseName, RT_Date: refreshalMonths, skipHierarchy: isLevel1, isCommon },
      uploadPath,
      'scorm',
      'scorm_zip',
      (normalizedError, normalizedResult, usedNormalizedSchema) => {
        if (normalizedError && !shouldFallbackToLegacySchema(normalizedError)) {
          console.error('Error saving normalized SCORM course:', normalizedError);
          return res.status(500).send(normalizedError.message || 'Error saving normalized course');
        }

        if (usedNormalizedSchema) {
          // SCORM courses are now graded the same way assessment courses are
          // (courseattempts/coursegrades, written by /updateUserSCORMDataInCourseTable) -
          // no separate legacy course_<id> table needs to be created here anymore.
          console.log('SCORM course saved to subcourses:', normalizedResult.insertId);
          saveTrainingLanguageRows(normalizedResult.insertId, 'regular', scormVariants, 'scorm_zip', error => {
            if (error) console.error('Error registering SCORM languages:', error);
          });
          // Send the admin back to the course list they were just looking at,
          // not the generic courseManagement.html - same convention as
          // /uploadTrainingMaterial and /uploadExcel.
          const postUploadRedirect = isLevel1
            ? '/l1Courses.html'
            : isCommon
              ? `/commonCourses.html?level=${encodeURIComponent(level || '')}`
              : `/l2Courses.html?mCourseID=${encodeURIComponent(req.body.mCourseID || '')}&stationID=${encodeURIComponent(req.body.stationID || '')}`;
          const script = `
            <script>
              const uploadConfirmation = confirm('SCORM course uploaded successfully. Click OK to return to the upload page.');
              if (uploadConfirmation) {
                window.location.href = '${postUploadRedirect}';
              }
            </script>
          `;
          return res.send(script);
        }

        // Insert course data into the courses table
        const query = `
          INSERT INTO courses (courseName, courseDescription, courseDate, scormPath, courseID, level, mCourseName, RT_Date)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `;

        // NOTE: pass the RELATIVE path "uploads/Scorm_xxx" to keep old behavior
        connection.query(query, [courseName, courseDescription, courseDate, uploadPath, courseID, level, mCourseName, RT_Date], (error, results) => {
          if (error) {
            console.error('Error saving course data:', error);
            return res.status(500).send('Internal Server Error');
          }
          console.log('Course data saved successfully');
          console.log('RT_Date stored as:', RT_Date);

          // Dynamically create column definitions
          let columnDefinitions = `
            id INT AUTO_INCREMENT PRIMARY KEY,
            uniqueID VARCHAR(255) NOT NULL,
            employeeID TEXT,
            name TEXT,
            noOfAttempts INT DEFAULT 0
          `;

          for (let i = 1; i <= 27; i++) {
            columnDefinitions += `,
              course_${courseID}_Posttest${i} LONGTEXT,
              score${i} LONGTEXT,
              status${i} LONGTEXT,
              duration${i} LONGTEXT,
              date${i} TEXT
            `;
          }

          const createTableQuery = `CREATE TABLE IF NOT EXISTS course_${courseID} (${columnDefinitions});`;

          connection.query(createTableQuery, (err) => {
            if (err) {
              console.error('Error creating course table:', err);
              return res.status(500).send('Error creating course table');
            }
            console.log(`Table course_${courseID} created successfully`);
          });

          const script = `
            <script>
              const uploadConfirmation = confirm('Course uploaded, table created, and user data inserted successfully. Click OK to return to the upload page.');
              if (uploadConfirmation) {
                window.location.href = '/'; // Redirect to the upload page
              }
            </script>
          `;
          res.send(script);
        });
      }
    );
  } catch (err) {
    console.error('Unexpected error in /upload:', err);
    res.status(500).send('Internal Server Error');
  }
});




function convertPptToPdf(inputPath, outputDir) {
  return new Promise((resolve, reject) => {
    // For Windows, if soffice is not on PATH, give full path:
    const sofficePath = "C:\\Program Files\\LibreOffice\\program\\soffice.exe";
    //const sofficePath = 'soffice';

    execFile(
      sofficePath,
      ['--headless', '--convert-to', 'pdf', '--outdir', outputDir, inputPath],
      (error, stdout, stderr) => {
        if (error) {
          console.error('LibreOffice conversion error:', error, stderr);
          return reject(error);
        }
        console.log('LibreOffice conversion output:', stdout);
        resolve();
      }
    );
  });
}


// Upload presentation-based course (PPT + optional Excel quiz)
// Upload presentation-based course (PPT/PDF + optional Excel quiz)
app.post(
  '/uploadPresentation',
  upload.fields([
    { name: 'pptFile', maxCount: 1 },
    { name: 'excelFile', maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      if (!req.files || !req.files.pptFile || req.files.pptFile.length === 0) {
        return res.status(400).send('No PPT/PDF file uploaded.');
      }

      const pptFile = req.files.pptFile[0];
      const excelFile =
        req.files.excelFile && req.files.excelFile.length > 0
          ? req.files.excelFile[0]
          : null;

      // Create folder like uploads/Scorm_1731950000000
      const folderName = `Scorm_${Date.now()}`;
      const uploadRelPath = path.join('uploads', folderName);
      const uploadAbsPath = path.join(__dirname, uploadRelPath);
      fs.mkdirSync(uploadAbsPath, { recursive: true });

      // Move uploaded file into this folder with a clean name
      const originalExt = path.extname(pptFile.originalname) || '.pptx';
      const lowerExt = originalExt.toLowerCase();

      const baseName = 'presentation';
      const originalFileName = baseName + originalExt;
      const originalDest = path.join(uploadAbsPath, originalFileName);
      fs.renameSync(pptFile.path, originalDest);

      // Decide what file the viewer should load
      let viewFileName = originalFileName;

      if (lowerExt !== '.pdf') {
        // Try to convert PPT/PPTX to PDF -> presentation.pdf
        try {
          console.log('Attempting to convert PPT to PDF for', originalDest);
          await convertPptToPdf(originalDest, uploadAbsPath);
          viewFileName = baseName + '.pdf'; // "presentation.pdf"
          console.log('Conversion successful, will use', viewFileName);
        } catch (convErr) {
          console.warn('PPT→PDF conversion failed, falling back to original PPT:', convErr);
          // viewFileName stays as originalFileName (PPT/PPTX) – viewer will show message
        }
      } else {
        // Already a PDF; just use it
        viewFileName = originalFileName;
      }

      let hasQuiz = false;
      if (excelFile) {
        // Normalize Excel name to questions.xlsx
        const excelDest = path.join(uploadAbsPath, 'questions.xlsx');
        fs.renameSync(excelFile.path, excelDest);
        hasQuiz = true;
      }

      // ====== Create presentationCourse.html in that folder ======
      const presentationHtmlPath = path.join(
        uploadAbsPath,
        'presentationCourse.html'
      );

      const htmlContent = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Presentation Course</title>
  <style>
    body { margin: 0; font-family: Arial, sans-serif; background: #f7f7f7; }
    .wrapper { max-width: 1200px; margin: 0 auto; padding: 16px; }
    #presentationContainer, #quizContainer {
      background: #fff; border-radius: 8px; padding: 16px;
      box-shadow: 0 2px 6px rgba(0,0,0,0.1);
    }
    #pptFrame { width: 100%; height: 600px; border: 1px solid #ccc; }
    .top-bar { display:flex; justify-content: space-between; align-items:center; margin-bottom: 8px; }
    button {
      padding: 8px 16px; border:none; border-radius:4px; cursor:pointer;
      background:#007bff; color:#fff; font-weight:bold;
    }
    button:disabled { opacity:0.6; cursor:not-allowed; }
    .question { margin-bottom: 12px; padding-bottom:8px; border-bottom:1px solid #eee; }
    .question-title { font-weight:bold; margin-bottom:4px; }
    .option { margin-left: 12px; }
    #quizContainer { display:none; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div id="presentationContainer">
      <div class="top-bar">
        <h2>Presentation</h2>
        <button id="endPresentationBtn">End Presentation</button>
      </div>
      <iframe id="pptFrame" src="" frameborder="0"></iframe>
    </div>

    <div id="quizContainer">
      <div class="top-bar">
        <h2>Quiz</h2>
      </div>
      <div id="quizQuestions"></div>
      <button id="submitQuizBtn">Submit Quiz</button>
    </div>
  </div>

  <script>
    const FOLDER_NAME = "${folderName}";
    const VIEW_FILE_NAME = "${viewFileName}";
    const HAS_QUIZ = ${hasQuiz ? 'true' : 'false'};

    const startTime = Date.now();
    let loadedQuestions = [];

    function formatDuration() {
      const diffMs = Date.now() - startTime;
      const totalSeconds = Math.floor(diffMs / 1000);
      const h = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
      const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
      const s = String(totalSeconds % 60).padStart(2, '0');
      return h + ":" + m + ":" + s;
    }

    function postResultToParent(scorePercent, status) {
      const duration = formatDuration();
      const payload = {
        type: "SCORM_DATA",
        Score: String(scorePercent),
        posttestScore: String(scorePercent),
        Status: status || "completed",
        duration: duration,
        ts: Date.now()
      };
      try {
        const origin = window.location.origin && window.location.origin !== "null"
          ? window.location.origin
          : "*";
        window.parent.postMessage(payload, origin);
        console.log("Presentation course result sent to parent:", payload);
      } catch (e) {
        console.warn("Failed to post SCORM_DATA from presentationCourse:", e);
      }
    }

    function loadPPT() {
      const frame = document.getElementById("pptFrame");
      const fileUrl = "/scorm/" + FOLDER_NAME + "/" + VIEW_FILE_NAME;
      const lower = VIEW_FILE_NAME.toLowerCase();

      if (lower.endsWith(".pdf")) {
        // Browser can show PDF directly
        frame.src = fileUrl;
        return;
      }

      // For PPT/PPTX fallback (conversion failed or soffice not installed)
      frame.style.display = "none";

      const msg = document.createElement("div");
msg.style.padding = "24px";
msg.innerHTML =
  '<h3>Cannot display this presentation type directly.</h3>' +
  '<p>' +
    'This file (<b>' + VIEW_FILE_NAME + '</b>) is a PowerPoint file. ' +
    'Web browsers cannot show PPT/PPTX offline inside the page.' +
  '</p>' +
  '<p>' +
    'Please install LibreOffice on the server or upload a <b>PDF</b> instead ' +
    'so it can be displayed here.' +
  '</p>';
frame.parentNode.appendChild(msg);

    }

    async function onEndPresentation() {
      if (!HAS_QUIZ) {
        if (confirm("No quiz attached. Mark this presentation as completed?")) {
          postResultToParent(0, "completed");
          alert("Presentation marked as completed.");
        }
        return;
      }

      document.getElementById("presentationContainer").style.display = "none";
      document.getElementById("quizContainer").style.display = "block";

      await loadQuestions();
    }

    async function loadQuestions() {
      try {
        const res = await fetch("/presentation-questions/" + encodeURIComponent(FOLDER_NAME));
        if (!res.ok) throw new Error("Failed to load questions");
        const data = await res.json();
        let questions = data.questions || [];

        if (!questions.length) {
          alert("No questions found in the Excel file. Marking as completed.");
          postResultToParent(0, "completed");
          return;
        }

        questions = questions.sort(() => Math.random() - 0.5).slice(0, 10);
        loadedQuestions = questions;

        const container = document.getElementById("quizQuestions");
        container.innerHTML = "";

        questions.forEach((q, idx) => {
          const qDiv = document.createElement("div");
          qDiv.className = "question";

          const title = document.createElement("div");
          title.className = "question-title";
          title.textContent = "Q" + (idx + 1) + ". " + (q.questionText || "");
          qDiv.appendChild(title);

          const opts = [
            { key: "A", text: q.option1Text },
            { key: "B", text: q.option2Text },
            { key: "C", text: q.option3Text },
            { key: "D", text: q.option4Text }
          ];

          opts.forEach(opt => {
            const label = document.createElement("label");
            label.className = "option";
            const input = document.createElement("input");
            input.type = "radio";
            input.name = "q" + idx;
            input.value = opt.key;
            label.appendChild(input);
            label.appendChild(document.createTextNode(" " + opt.key + ". " + (opt.text || "")));
            qDiv.appendChild(label);
            qDiv.appendChild(document.createElement("br"));
          });

          container.appendChild(qDiv);
        });

      } catch (e) {
        console.error(e);
        alert("Error loading questions. Marking as completed.");
        postResultToParent(0, "completed");
      }
    }

    function onSubmitQuiz() {
      if (!loadedQuestions.length) {
        alert("No questions loaded.");
        return;
      }

      let correct = 0;
      const total = loadedQuestions.length;

      loadedQuestions.forEach((q, idx) => {
        const selected = (document.querySelector('input[name="q' + idx + '"]:checked') || {}).value;
        const ans = (q.answerText || "").toString().trim().toUpperCase();
        if (selected && selected.toUpperCase() === ans) {
          correct++;
        }
      });

      const scorePercent = total ? Math.round((correct / total) * 100) : 0;
      alert("You scored " + scorePercent + "% (" + correct + " / " + total + ").");

      postResultToParent(scorePercent, "completed");

      document.getElementById("submitQuizBtn").disabled = true;
    }

    document.getElementById("endPresentationBtn").addEventListener("click", onEndPresentation);
    document.getElementById("submitQuizBtn").addEventListener("click", onSubmitQuiz);

    window.addEventListener("load", loadPPT);
  </script>
</body>
</html>`;

      fs.writeFileSync(presentationHtmlPath, htmlContent, 'utf8');
      console.log('presentationCourse.html created at', presentationHtmlPath);

      // ====== Insert course row in DB (same as /upload) ======
      let {
        courseName,
        courseDescription,
        courseDate,
        courseID,
        level,
        mCourseName,
        RT_Date,
      } = req.body;

      if (!level || level.trim() === '') {
        level = 'default';
      }

      const refreshalMonths = RT_Date;
      RT_Date = calculateRefreshalDate(courseDate, refreshalMonths);

      if (RT_Date) {
        console.log(`Calculated RT_Date: ${RT_Date} (${refreshalMonths} months from ${courseDate})`);
      }

      const insertQuery = `
        INSERT INTO courses (courseName, courseDescription, courseDate, scormPath, courseID, level, mCourseName, RT_Date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `;

      connection.query(
        insertQuery,
        [
          courseName,
          courseDescription,
          courseDate,
          uploadRelPath,
          courseID,
          level,
          mCourseName,
          RT_Date,
        ],
        (error, results) => {
          if (error) {
            console.error('Error saving presentation course data:', error);
            return res.status(500).send('Internal Server Error');
          }

          console.log('Presentation course saved successfully');

          // ====== Create course_${courseID} table (same structure) ======
          let columnDefinitions = `
            id INT AUTO_INCREMENT PRIMARY KEY,
            uniqueID VARCHAR(255) NOT NULL,
            employeeID TEXT,
            name TEXT,
            noOfAttempts INT DEFAULT 0
          `;

          for (let i = 1; i <= 27; i++) {
            columnDefinitions += `,
              course_${courseID}_Posttest${i} LONGTEXT,
              score${i} LONGTEXT,
              status${i} LONGTEXT,
              duration${i} LONGTEXT,
              date${i} TEXT
            `;
          }

          const createTableQuery = `CREATE TABLE IF NOT EXISTS course_${courseID} (${columnDefinitions});`;

          connection.query(createTableQuery, (err) => {
            if (err) {
              console.error('Error creating course table:', err);
              return res.status(500).send('Error creating course table');
            }
            console.log(`Table course_${courseID} for presentation course created successfully`);

          });

          return res.json({ success: true, message: 'Presentation course uploaded successfully' });

        }
      );
    } catch (err) {
      console.error('Unexpected error in /uploadPresentation:', err);
      res.status(500).send('Internal Server Error');
    }
  }
);





// // Serve SCORM content based on selected folder
// app.get('/scorm/:folderName', (req, res) => {
//   const folderName = req.params.folderName;
//   const filePath = path.join(__dirname, 'uploads', folderName, 'story.html');

//   fs.access(filePath, fs.constants.F_OK, (err) => {
//     if (err) {
//       console.error(err);
//       res.status(404).send('File not found');
//     } else {
//       res.sendFile(filePath);
//     }
//   });
// });


// Serve SCORM content based on selected folder
app.get('/scorm/:folderName', (req, res) => {
  const folderName = req.params.folderName;

  const indexLmsPath = path.join(__dirname, 'uploads', folderName, 'index_lms.html');
  const primaryFilePath = path.join(__dirname, 'uploads', folderName, 'story.html');
  const alternateFilePath = path.join(
    __dirname,
    'Excel Assessment',
    'Assessment pages',
    `${folderName} _quiz.html`
  );

  // 1) Try index_lms.html
  fs.access(indexLmsPath, fs.constants.F_OK, (indexErr) => {
    if (!indexErr) {
      return res.sendFile(indexLmsPath);
    }

    // 2) Try story.html
    fs.access(primaryFilePath, fs.constants.F_OK, (storyErr) => {
      if (!storyErr) {
        return res.sendFile(primaryFilePath);
      }

      // 3) Fallback: quiz html
      fs.access(alternateFilePath, fs.constants.F_OK, (altErr) => {
        if (!altErr) {
          return res.sendFile(alternateFilePath);
        }

        console.error(
          `File not found in any location: ${indexLmsPath}, ${primaryFilePath}, ${alternateFilePath} `
        );
        return res.status(404).send('File not found');
      });
    });
  });
});




let currentCourseID;
app.get('/getRefreshalTrainingCourses', (req, res) => {
  if (!req.session || !req.session.user || !req.session.user.uniqueID) {
    return res.status(401).json({ error: 'User not authenticated' });
  }

  const uniqueID = req.session.user.uniqueID;

  // Get all courses with RT_Date
  const coursesQuery = 'SELECT courseID, courseName, RT_Date FROM courses WHERE RT_Date IS NOT NULL ORDER BY courseID';

  connection.query(coursesQuery, async (coursesError, courses) => {
    if (coursesError) {
      console.error('Error retrieving courses:', coursesError);
      return res.status(500).json({ error: 'Internal Server Error' });
    }

    if (courses.length === 0) {
      return res.json({ refreshalCourses: [] });
    }

    const refreshalCourses = [];
    const currentDate = new Date();
    currentDate.setHours(0, 0, 0, 0); // Normalize to start of day

    // Check each course
    const coursePromises = courses.map((course) => {
      return new Promise((resolve) => {
        const tableName = `course_${course.courseID}`;

        // Check if table exists
        const checkTableQuery = `SHOW TABLES LIKE '${tableName}'`;

        connection.query(checkTableQuery, (checkErr, tableExists) => {
          if (checkErr || !tableExists || tableExists.length === 0) {
            return resolve(null);
          }

          // Check if user is enrolled and has passed the course
          const userQuery = `
            SELECT 
              COALESCE(
                NULLIF(TRIM(status27), ''),
                NULLIF(TRIM(status26), ''),
                NULLIF(TRIM(status25), ''),
                NULLIF(TRIM(status24), ''),
                NULLIF(TRIM(status23), ''),
                NULLIF(TRIM(status22), ''),
                NULLIF(TRIM(status21), ''),
                NULLIF(TRIM(status20), ''),
                NULLIF(TRIM(status19), ''),
                NULLIF(TRIM(status18), ''),
                NULLIF(TRIM(status17), ''),
                NULLIF(TRIM(status16), ''),
                NULLIF(TRIM(status15), ''),
                NULLIF(TRIM(status14), ''),
                NULLIF(TRIM(status13), ''),
                NULLIF(TRIM(status12), ''),
                NULLIF(TRIM(status11), ''),
                NULLIF(TRIM(status10), ''),
                NULLIF(TRIM(status9), ''),
                NULLIF(TRIM(status8), ''),
                NULLIF(TRIM(status7), ''),
                NULLIF(TRIM(status6), ''),
                NULLIF(TRIM(status5), ''),
                NULLIF(TRIM(status4), ''),
                NULLIF(TRIM(status3), ''),
                NULLIF(TRIM(status2), ''),
                NULLIF(TRIM(status1), '')
              ) as latestStatus
            FROM ${tableName}
            WHERE uniqueID = ?
            LIMIT 1
          `;

          connection.query(userQuery, [uniqueID], (userErr, userResults) => {
            if (userErr || !userResults || userResults.length === 0) {
              return resolve(null);
            }

            const latestStatus = userResults[0].latestStatus;

            // Check if user has passed (completed) the course
            if (!latestStatus || (latestStatus.toLowerCase() !== 'passed' && latestStatus.toLowerCase() !== 'completed')) {
              console.log(`User has not passed course ${course.courseID} yet`);
              return resolve(null);
            }

            // Check if RT_Date is due or has passed
            if (!course.RT_Date) {
              console.log(`No RT_Date set for course ${course.courseID}`);
              return resolve(null);
            }

            const rtDate = new Date(course.RT_Date);
            rtDate.setHours(0, 0, 0, 0); // Normalize to start of day

            if (currentDate >= rtDate) {
              // Calculate days overdue
              const timeDiff = currentDate - rtDate;
              const daysOverdue = Math.floor(timeDiff / (1000 * 60 * 60 * 24));

              console.log(`✅ Refreshal needed for ${course.courseID}: RT_Date ${course.RT_Date} is ${daysOverdue} days overdue`);

              resolve({
                courseID: course.courseID,
                courseName: course.courseName,
                rtDate: course.RT_Date,
                daysOverdue: daysOverdue
              });
            } else {
              // Calculate days until due
              const timeDiff = rtDate - currentDate;
              const daysUntilDue = Math.ceil(timeDiff / (1000 * 60 * 60 * 24));

              console.log(`RT_Date not due yet for ${course.courseID}: ${daysUntilDue} days remaining`);
              resolve(null);
            }
          });
        });
      });
    });

    try {
      const results = await Promise.all(coursePromises);
      const validRefreshalCourses = results.filter(r => r !== null);

      console.log(`Found ${validRefreshalCourses.length} courses due for refreshal training`);
      res.json({ refreshalCourses: validRefreshalCourses });
    } catch (error) {
      console.error('Error checking refreshal training:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });
});

// Get refreshal training status for a specific course and user
app.get('/getRefreshalTrainingStatus', (req, res) => {
  if (!req.session || !req.session.user || !req.session.user.uniqueID) {
    return res.status(401).json({ error: 'User not authenticated' });
  }

  const uniqueID = req.session.user.uniqueID;
  const { courseID } = req.query;

  if (!courseID) {
    return res.status(400).json({ error: 'Course ID is required' });
  }

  // Query to get the latest status from refreshaltrain table
  const query = `
    SELECT 
      COALESCE(
        NULLIF(TRIM(status4), ''),
        NULLIF(TRIM(status3), ''),
        NULLIF(TRIM(status2), ''),
        NULLIF(TRIM(status1), '')
      ) as latestStatus,
      noOfAttempts,
      courseID as refreshalCourseID
    FROM refreshaltrain
    WHERE originalCourseID = ? AND uniqueID = ?
    ORDER BY id DESC
    LIMIT 1
  `;

  connection.query(query, [courseID, uniqueID], (error, results) => {
    if (error) {
      console.error('Error fetching refreshal status:', error);
      return res.status(500).json({ error: 'Internal Server Error' });
    }

    if (results.length === 0) {
      // No refreshal training record exists yet
      return res.json({
        status: 'Not Started',
        noOfAttempts: 0,
        refreshalCourseID: null
      });
    }

    const result = results[0];
    let status = result.latestStatus || 'Not Started';

    // Apply status mapping logic
    const lowerStatus = status.toLowerCase();
    if (lowerStatus === 'passed' || lowerStatus === 'failed' || lowerStatus === 'fail') {
      status = 'Completed';
    } else if (lowerStatus === 'unknown' || lowerStatus === 'suspend' || lowerStatus === 'suspended') {
      status = 'Attempted';
    } else if (lowerStatus === 'incomplete' || lowerStatus === 'browsed') {
      status = 'Attempted';
    } else if (lowerStatus !== 'not started') {
      // For any other status, capitalize first letter
      status = status.charAt(0).toUpperCase() + status.slice(1);
    }

    res.json({
      status: status,
      noOfAttempts: result.noOfAttempts || 0,
      refreshalCourseID: result.refreshalCourseID
    });
  });
});

// Create refreshal training table and insert course data
// Create refreshal training table with attempt tracking columns
// Create refreshal training entry (table already exists in database)
app.post('/createRefreshalTraining', (req, res) => {
  const { courseID, courseName, courseDescription, courseDate, level, mCourseName } = req.body;

  if (!courseID) {
    return res.status(400).json({ error: 'Course ID is required' });
  }

  // Insert refreshal training course entry
  const insertQuery = `
    INSERT INTO refreshaltrain 
    (courseName, courseDescription, courseDate, scormPath, courseID, level, mCourseName, originalCourseID) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const refreshalCourseID = `RF_${courseID}_${Date.now()}`;
  const scormPath = `refreshal_${courseID}`;

  connection.query(
    insertQuery,
    [courseName, courseDescription, courseDate, scormPath, refreshalCourseID, level, mCourseName, courseID],
    (insertErr, results) => {
      if (insertErr) {
        console.error('Error inserting refreshal training:', insertErr);
        return res.status(500).json({ error: 'Error creating refreshal training course' });
      }

      console.log(`Refreshal training created: ${refreshalCourseID}`);
      res.json({
        success: true,
        message: 'Refreshal training course created',
        refreshalCourseID: refreshalCourseID
      });
    }
  );
});

// Get refreshal course details
app.get('/getRefreshalCourse/:originalCourseID', (req, res) => {
  const { originalCourseID } = req.params;

  if (!req.session?.user?.uniqueID) {
    return res.status(401).json({ error: 'User session not found' });
  }

  const uniqueID = req.session.user.uniqueID;

  // Get original course details
  const originalCourseQuery = 'SELECT * FROM courses WHERE courseID = ?';

  connection.query(originalCourseQuery, [originalCourseID], (err, results) => {
    if (err) {
      console.error('Error fetching original course:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (results.length === 0) {
      return res.status(404).json({ error: 'Original course not found' });
    }

    const originalCourse = results[0];

    // Check if refreshal training entry exists for this user and course
    const checkRefreshalQuery = `
      SELECT * FROM refreshaltrain 
      WHERE originalCourseID = ? AND uniqueID = ?
      ORDER BY id DESC LIMIT 1
    `;

    connection.query(checkRefreshalQuery, [originalCourseID, uniqueID], (checkErr, refreshalResults) => {
      if (checkErr) {
        console.error('Error checking refreshal:', checkErr);
        return res.status(500).json({ error: 'Database error' });
      }

      if (refreshalResults.length > 0) {
        // Return existing refreshal course entry
        return res.json({
          success: true,
          refreshalCourse: refreshalResults[0],
          originalCourse: originalCourse
        });
      }

      // Create new refreshal training entry for this user
      const refreshalCourseID = `RF_${originalCourseID}_${Date.now()}`;
      const insertQuery = `
        INSERT INTO refreshaltrain 
        (courseName, courseDescription, courseDate, scormPath, courseID, level, mCourseName, originalCourseID, uniqueID, employeeID, name, noOfAttempts) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      `;

      connection.query(
        insertQuery,
        [
          `${originalCourse.courseName} (Refreshal)`,
          originalCourse.courseDescription,
          new Date().toISOString().split('T')[0],
          originalCourse.scormPath,
          refreshalCourseID,
          originalCourse.level,
          originalCourse.mCourseName,
          originalCourseID,
          uniqueID,
          req.session.user.employeeID || '',
          req.session.user.name || ''
        ],
        (insertErr, insertResult) => {
          if (insertErr) {
            console.error('Error creating refreshal:', insertErr);
            return res.status(500).json({ error: 'Error creating refreshal course' });
          }

          // Fetch the newly created refreshal course entry
          connection.query(checkRefreshalQuery, [originalCourseID, uniqueID], (fetchErr, newResults) => {
            if (fetchErr || newResults.length === 0) {
              return res.status(500).json({ error: 'Error fetching created refreshal' });
            }

            res.json({
              success: true,
              refreshalCourse: newResults[0],
              originalCourse: originalCourse,
              newlyCreated: true
            });
          });
        }
      );
    });
  });
});

// Update refreshal training data
// Update refreshal training data
// Update refreshal training data
// Update refreshal training data
app.post('/updateRefreshalTrainingData', (req, res) => {
  const { posttestScore, Score, Status, duration, refreshalCourseID } = req.body;

  // Log incoming data for debugging
  console.log(`📥 Refreshal update request for ${refreshalCourseID}: posttestScore=${posttestScore}, Score=${Score}, Status=${Status}, duration=${duration}`);

  if (!req.session?.user?.uniqueID) {
    return res.status(401).send('User session not found');
  }
  const uniqueID = req.session.user.uniqueID;

  // Skip non-final updates (e.g., progress saves with 'unknown' status)
  if (!Status || (Status.toLowerCase() !== 'passed' && Status.toLowerCase() !== 'completed') || !Score || Score < 0) {
    console.log(`⏭️ Skipping non-final update for ${refreshalCourseID}: Status=${Status}, Score=${Score}`);
    return res.json({ success: true, message: 'Skipped non-final update', skipped: true });
  }

  // Get current attempt number and record ID
  const getAttemptQuery = `
    SELECT noOfAttempts, id
    FROM refreshaltrain
    WHERE courseID = ? AND uniqueID = ?
  `;
  connection.query(getAttemptQuery, [refreshalCourseID, uniqueID], (error, results) => {
    if (error) {
      console.error('Error fetching attempt count:', error);
      return res.status(500).send('Internal Server Error');
    }
    if (results.length === 0) {
      return res.status(404).send('Refreshal training record not found');
    }
    let currentAttempts = parseInt(results[0].noOfAttempts);

    if (!currentAttempts || currentAttempts < 1) {
      currentAttempts = 1;
    }

    const recordId = results[0].id;

    // Check if current attempt is in-progress (date set, but score null/empty/0)
    const checkInProgressQuery = `
      SELECT score${currentAttempts} AS currentScore
      FROM refreshaltrain
      WHERE id = ? AND date${currentAttempts} IS NOT NULL AND (score${currentAttempts} IS NULL OR score${currentAttempts} = '' OR score${currentAttempts} = '0')
    `;
    connection.query(checkInProgressQuery, [recordId], (checkErr, checkResults) => {
      if (checkErr) {
        console.error('Error checking in-progress:', checkErr);
        return res.status(500).send('Internal Server Error');
      }

      // Debug logging
      console.log(`🔍 In-progress check for ${refreshalCourseID}: currentAttempts=${currentAttempts}, checkResults.length=${checkResults.length}, currentScore=${checkResults[0]?.currentScore || 'N/A'}`);

      let targetAttempt = currentAttempts;  // Default: new attempt
      if (checkResults.length > 0) {
        const currentScore = checkResults[0].currentScore;
        if (currentScore === null || currentScore === '' || currentScore === '0' || currentScore.trim() === '') {
          targetAttempt = currentAttempts;
          console.log(`📝 Updating in-progress attempt ${targetAttempt} for ${refreshalCourseID} (score was ${currentScore})`);
        } else {
          console.log(`⚠️ Current attempt ${currentAttempts} already has score ${currentScore}; starting new`);
        }
      } else {
        console.log(`⚠️ No in-progress match for attempt ${currentAttempts}; starting new`);
      }

      // Idempotency: For 'passed', check if recent (within 1 min) to reuse
      if (targetAttempt === currentAttempts + 1 && Status.toLowerCase() === 'passed') {
        const recentQuery = `
          SELECT date${currentAttempts} AS lastDate
          FROM refreshaltrain
          WHERE id = ?
        `;
        connection.query(recentQuery, [recordId], (recentErr, recentResults) => {
          if (recentErr) {
            console.error('Error checking recent date:', recentErr);
            return res.status(500).send('Internal Server Error');
          }
          let finalTarget = targetAttempt;
          if (recentResults.length > 0 && recentResults[0].lastDate) {
            const lastDate = new Date(recentResults[0].lastDate);
            const now = new Date();
            const oneMinAgo = new Date(now.getTime() - 60000);  // 1 min
            if (lastDate > oneMinAgo) {
              finalTarget = currentAttempts;  // Reuse last
              console.log(`🔄 Reusing recent attempt ${finalTarget} for ${refreshalCourseID} (within 1 min)`);
            }
          }
          // Proceed with finalTarget
          performUpdate(finalTarget);
        });
        return;  // Nested handling
      } else {
        performUpdate(targetAttempt);
      }

      // Extracted update function
      function performUpdate(finalTarget) {
        // Cap at 3 attempts
        const MAX_ATTEMPTS = 3;
        if (finalTarget > MAX_ATTEMPTS) {
          console.log(`❌ Max attempts (${MAX_ATTEMPTS}) reached for refreshal ${refreshalCourseID}. Skipping update.`);
          return res.status(400).json({
            success: false,
            message: `Maximum ${MAX_ATTEMPTS} attempts reached. Cannot submit more.`
          });
        }

        const date = getFormattedDateTimeIST();  // Assume this exists

        // Safely default empties to NULL
        const safePosttest = posttestScore || null;
        const safeScore = Score || null;
        const safeStatus = Status || null;
        const safeDuration = duration || null;

        // Clean SQL
        const updateQuery = `
          UPDATE refreshaltrain
          SET course_Posttest${finalTarget} = ?,
              score${finalTarget} = ?,
              status${finalTarget} = ?,
              duration${finalTarget} = ?,
              date${finalTarget} = ?,
              noOfAttempts = ?
          WHERE id = ?
        `;
        connection.query(
          updateQuery,
          [safePosttest, safeScore, safeStatus, safeDuration, date, finalTarget, recordId],
          (error2) => {
            if (error2) {
              console.error('Error updating refreshal data:', error2);
              if (error2.code === 'ER_BAD_FIELD_ERROR') {
                return res.status(500).json({
                  success: false,
                  message: `Schema error: Missing columns for attempt ${finalTarget}. Add them via ALTER TABLE.`
                });
              }
              return res.status(500).send('Internal Server Error');
            }
            console.log(`✅ Refreshal training data updated for attempt ${finalTarget} (capped at ${MAX_ATTEMPTS})`);
            res.json({
              success: true,
              message: 'Refreshal training updated successfully',
              attempt: finalTarget
            });
          }
        );
      }
    });
  });
});

// Get all refreshal training records for a user
app.get('/getUserRefreshalTrainings', (req, res) => {
  if (!req.session?.user?.uniqueID) {
    return res.status(401).json({ error: 'User session not found' });
  }

  const uniqueID = req.session.user.uniqueID;

  const query = `
    SELECT * FROM refreshaltrain 
    WHERE uniqueID = ?
    ORDER BY createdDate DESC
  `;

  connection.query(query, [uniqueID], (error, results) => {
    if (error) {
      console.error('Error fetching user refreshal trainings:', error);
      return res.status(500).json({ error: 'Database error' });
    }

    res.json({
      success: true,
      refreshalTrainings: results
    });
  });
});


// get the uploaded scorm list on viewscorm page
app.get('/getUploadedScorms', (req, res) => {
  const scormsDir = path.join(__dirname, 'uploads');
  const query = `SELECT courseName, scormPath FROM courses ORDER BY id DESC`;
  fs.readdir(scormsDir, (err, files) => {
    if (err) {
      console.error(err);
      res.status(500).send('Internal Server Error');
    } else {
      const scormFolders = files.filter(file => {
        return fs.statSync(path.join(scormsDir, file)).isDirectory();
      }).map(folder => ({
        folderName: folder,
        folderPath: path.join(scormsDir, folder)
      }));
      res.json(scormFolders);
    }
  });
});


//Get the course list on courseManagemnet page
app.get('/getCourseList', (req, res) => {
  const normalizedQuery = normalizedCourseListQuery();
  const legacyQuery = `SELECT id, courseName, courseDate, courseDescription, mCourseName, level, courseTeacher, scormPath, courseID FROM courses ORDER BY id DESC`;
  sendLegacyOrNormalizedCourseList(res, normalizedQuery, [], legacyQuery);
});

// Admin-only course listing used by the new Level 1 (Induction) and Level 2+
// (OJT) course management pages (public/l1Courses.html, public/l2Courses.html).
// scope=level1  -> standalone Level 1 courses (deptID/areaID/mCourseID all NULL)
// scope=level2  -> courses under a specific Process/Line (mCourseID required)
// This is purely additive and does not change /getCourseList or
// /getViewscormCourseList (employee-facing, session-gated - left untouched).
app.get('/api/admin/courseListing', (req, res) => {
  const { scope, mCourseID } = req.query;

  if (scope === 'level1') {
    // A standalone course is not automatically a Level 1 course: common
    // Level 2/3/4 courses also have no hierarchy. Require the explicit
    // Level 1 tag as well, so Level 2 common courses never leak into the
    // Induction Courses page.
    const whereClause = "WHERE sc.deptID IS NULL AND sc.areaID IS NULL AND sc.mCourseID IS NULL AND sc.subCourseLevel = 'Level 1'";
    const query = normalizedCourseListQuery(whereClause);
    return connection.query(query, [], (error, results) => {
      if (error) {
        console.error('Error fetching Level 1 course listing:', error);
        return res.status(500).json({ success: false, error: 'Database error' });
      }
      res.json({ success: true, courses: results });
    });
  }

  if (scope === 'level2') {
    if (!mCourseID) {
      return res.status(400).json({ success: false, error: 'mCourseID is required for scope=level2' });
    }
    // Optional level filter (Level 2/3/4 - see the Level dropdown on
    // l2Courses.html). Courses uploaded before that dropdown existed are
    // tagged subCourseLevel = 'default' (or NULL); treat those as Level 2
    // so they keep showing up rather than vanishing from every tab.
    const { level, stationID } = req.query;
    let whereClause = 'WHERE sc.mCourseID = ?';
    const params = [mCourseID];
    // Optional Station filter: 0 = whole-Line legacy courses, which stay
    // visible under every station on this Line (backward compatible).
    if (stationID) {
      whereClause += ' AND (sc.stationID = 0 OR sc.stationID = ?)';
      params.push(stationID);
    }
    if (level === 'Level 2') {
      whereClause += " AND (sc.subCourseLevel IS NULL OR sc.subCourseLevel IN (?))";
      params.push([level, 'default']);
    } else if (level === 'Level 3' || level === 'Level 4') {
      whereClause += ' AND sc.subCourseLevel = ?';
      params.push(level);
    } else {
      // "All levels" - still must never show Level 1 courses here, even if a
      // row was mistakenly tagged with an mCourseID (any casing/spacing of
      // "level 1" / "level1"). This list is Level 2 and above only.
      whereClause += " AND (sc.subCourseLevel IS NULL OR LOWER(REPLACE(sc.subCourseLevel, ' ', '')) <> 'level1')";
    }
    const query = normalizedCourseListQuery(whereClause);
    return connection.query(query, params, (error, results) => {
      if (error) {
        console.error('Error fetching Level 2+ course listing:', error);
        return res.status(500).json({ success: false, error: 'Database error' });
      }
      res.json({ success: true, courses: results });
    });
  }

  if (scope === 'common') {
    // Common courses: no Dept/Area/Process-Line/Station at all, tagged to a
    // specific Level (2/3/4) - visible to every learner already in the
    // Level 2+ pipeline, regardless of which Line/Station they're on.
    const { level } = req.query;
    if (!level || !['Level 2', 'Level 3', 'Level 4'].includes(level)) {
      return res.status(400).json({ success: false, error: "level must be 'Level 2', 'Level 3' or 'Level 4' for scope=common" });
    }
    const whereClause = 'WHERE sc.mCourseID IS NULL AND sc.deptID IS NULL AND sc.subCourseLevel = ?';
    const query = normalizedCourseListQuery(whereClause);
    return connection.query(query, [level], (error, results) => {
      if (error) {
        console.error('Error fetching Common course listing:', error);
        return res.status(500).json({ success: false, error: 'Database error' });
      }
      res.json({ success: true, courses: results });
    });
  }

  return res.status(400).json({ success: false, error: "scope must be 'level1', 'level2' or 'common'" });
});

app.get('/api/admin/refresherCourseListing', (req, res) => {
  const query = `
    SELECT
      subCourseID AS id,
      subCourseName AS courseName,
      subCourseDate AS courseDate,
      subCourseDescription AS courseDescription,
      subCourseTeacher AS courseTeacher,
      COALESCE(scormPath, subCoursePath) AS scormPath,
      subCourseID AS courseID,
      COALESCE(subCourseLevel, 'Refresher') AS level,
      courseType,
      contentType,
      subCoursePassing
    FROM refresher_subcourses
    ORDER BY subCourseID DESC
  `;

  connection.query(query, (error, results) => {
    if (error) {
      console.error('Error fetching refresher course listing:', error);
      return res.status(500).json({ success: false, error: 'Database error', details: error.message });
    }
    res.json({ success: true, courses: results });
  });
});

// ---------------------------------------------------------------------------
// Admin Course View page (public/courseView.html) - additive admin-only API.
// Lets an admin see/edit a course's metadata, replace its main course file,
// and manage its question bank. None of this touches employee-facing routes
// (/getViewscormCourseList, /training/:courseID, /submitPosttestData, SCORM
// serving) - those are left completely untouched per the standing rule that
// employee login/course-attempting must never change.
// ---------------------------------------------------------------------------

const courseFileUpload = multer().fields([{ name: 'courseFile', maxCount: 1 }]);
const questionImageUpload = multer().fields([{ name: 'image', maxCount: 1 }]);

// Combined course metadata + question bank, for the Course View page to render.
app.get('/api/admin/courseDetails/:courseID', (req, res) => {
  const subCourseID = req.params.courseID;
  // Refresher courses live in their own standalone refresher_subcourses table
  // (separate auto-increment ID space, no Department/Segment/Process-Line
  // hierarchy) - see public/refresherCourses.html / public/index.html. The
  // caller flags this explicitly with ?source=refresher instead of us trying
  // to guess by ID, since both tables auto-increment independently.
  const isRefresher = req.query.source === 'refresher';
  const courseQuery = isRefresher
    ? `
      SELECT
        sc.subCourseID, sc.subCourseName, sc.subCourseDescription, sc.subCourseDate,
        sc.subCourseTeacher, sc.subCourseLevel, sc.subCourseRefreshDate, sc.subCoursePassing,
        sc.courseType, sc.contentType, COALESCE(sc.scormPath, sc.subCoursePath) AS filePath,
        sc.deptID, sc.areaID, sc.mCourseID, sc.coMCourseID,
        NULL AS subCourseRoles,
        NULL AS departmentName, NULL AS areaName, NULL AS mCourseName, NULL AS coMCourseName
      FROM refresher_subcourses sc
      WHERE sc.subCourseID = ?
      LIMIT 1
    `
    : `
    SELECT
      sc.subCourseID, sc.subCourseName, sc.subCourseDescription, sc.subCourseDate,
      sc.subCourseTeacher, sc.subCourseLevel, sc.subCourseRefreshDate, sc.subCoursePassing,
      sc.courseType, sc.contentType, COALESCE(sc.scormPath, sc.subCoursePath) AS filePath,
      sc.deptID, sc.areaID, sc.mCourseID, sc.coMCourseID, sc.subCourseRoles,
      d.deptName AS departmentName, a.areaName, m.mCourseName, co.coMCourseName
    FROM subcourses sc
    LEFT JOIN departments d ON d.deptID = sc.deptID
    LEFT JOIN areas a ON a.areaID = sc.areaID
    LEFT JOIN mcourses m ON m.mCourseID = sc.mCourseID
    LEFT JOIN comaincourses co ON co.coMCourseID = sc.coMCourseID
    WHERE sc.subCourseID = ?
    LIMIT 1
  `;
  connection.query(courseQuery, [subCourseID], (error, courseRows) => {
    if (error) {
      console.error('Error fetching course details:', error);
      return res.status(500).json({ success: false, error: 'Database error' });
    }
    if (!courseRows.length) {
      return res.status(404).json({ success: false, error: 'Course not found' });
    }
    connection.query(
      'SELECT * FROM subcourse_questions WHERE subCourseID = ? ORDER BY questionOrder ASC, questionID ASC',
      [subCourseID],
      (qError, questionRows) => {
        if (qError) {
          console.error('Error fetching subcourse_questions:', qError);
          return res.status(500).json({ success: false, error: 'Database error' });
        }
        res.json({ success: true, course: courseRows[0], questions: questionRows });
      }
    );
  });
});

// Updates editable metadata fields only. Does not touch file paths, courseType,
// contentType, or hierarchy columns (deptID/areaID/mCourseID/coMCourseID).
app.put('/api/admin/courseDetails/:courseID', (req, res) => {
  const subCourseID = req.params.courseID;
  const isRefresher = req.query.source === 'refresher';
  const tableName = isRefresher ? 'refresher_subcourses' : 'subcourses';
  const {
    subCourseName, subCourseDescription, subCourseTeacher,
    subCourseLevel, subCourseRefreshDate, subCoursePassing, subCourseDate,
    subCourseRoles,
  } = req.body;

  // subCourseRoles only exists on subcourses, not refresher_subcourses (see
  // migration in ensureStationsTable) - and courseView.html only sends it
  // when the Roles field is visible (Level 1 course). Only touch the column
  // when the caller actually sent it, so saving a Level 2+/Refresher course
  // never silently wipes out a Level 1 course's role restriction.
  const hasRolesField = !isRefresher && Object.prototype.hasOwnProperty.call(req.body, 'subCourseRoles');

  const setClauses = [
    'subCourseName = ?', 'subCourseDescription = ?', 'subCourseTeacher = ?',
    'subCourseLevel = ?', 'subCourseRefreshDate = ?', 'subCoursePassing = ?', 'subCourseDate = ?',
  ];
  const queryParams = [
    subCourseName || null,
    subCourseDescription || null,
    subCourseTeacher || null,
    subCourseLevel || null,
    subCourseRefreshDate || null,
    subCoursePassing || null,
    subCourseDate || null,
  ];
  if (hasRolesField) {
    setClauses.push('subCourseRoles = ?');
    queryParams.push(normalizeSubCourseRoles(subCourseRoles));
  }
  queryParams.push(subCourseID);

  const query = `UPDATE ${tableName} SET ${setClauses.join(', ')} WHERE subCourseID = ?`;

  connection.query(
    query,
    queryParams,
    (error, result) => {
      if (error) {
        console.error('Error updating course details:', error);
        return res.status(500).json({ success: false, error: 'Database error' });
      }
      if (!result.affectedRows) {
        return res.status(404).json({ success: false, error: 'Course not found' });
      }
      res.json({ success: true });
    }
  );
});

// Deletes a course master record (admin-only, from the Course Management
// list pages). Removes its question bank rows first, then the subcourses
// row itself. Does not touch employee-facing routes/tables (enrollstatus,
// courseattempts, scorm_attempt_data) - those keep referencing the deleted
// subCourseID by ID only, exactly like any other historical record.
app.delete('/api/admin/courseDetails/:courseID', (req, res) => {
  const subCourseID = req.params.courseID;
  const isRefresher = req.query.source === 'refresher';
  const tableName = isRefresher ? 'refresher_subcourses' : 'subcourses';
  connection.query('DELETE FROM subcourse_questions WHERE subCourseID = ?', [subCourseID], (qError) => {
    if (qError) {
      console.error('Error deleting course questions:', qError);
      return res.status(500).json({ success: false, error: 'Database error', details: qError.message });
    }
    connection.query(`DELETE FROM ${tableName} WHERE subCourseID = ?`, [subCourseID], (error, result) => {
      if (error) {
        console.error('Error deleting course:', error);
        return res.status(500).json({ success: false, error: 'Database error', details: error.message });
      }
      if (!result.affectedRows) {
        return res.status(404).json({ success: false, error: 'Course not found' });
      }
      res.json({ success: true, deleted: result.affectedRows });
    });
  });
});

// Works out whether/how a course's main file can be replaced. SCORM packages
// are intentionally excluded (replaceable: false) - they are left alone per
// the standing "do not touch SCORM" rule. Training-type courses store a
// direct file path (one file, easy to swap). Assessment-type courses store a
// directory; only the optional video/ppt media inside it is treated as the
// "main file" - the Excel-derived questions are edited via the question bank
// instead, not by replacing a file.
function resolveMainCourseFileInfo(courseRow) {
  const { subCourseID, courseType, contentType, subCoursePath, scormPath } = courseRow;
  const storedRelativePath = scormPath || subCoursePath;

  if (contentType === 'scorm_zip') {
    return { replaceable: false, reason: 'SCORM packages cannot be replaced from this page.' };
  }

  if (!storedRelativePath) {
    return { replaceable: false, reason: 'No file path on record for this course.' };
  }

  const normalizedRelative = String(storedRelativePath).replace(/\\/g, '/');

  if (courseType === 'training') {
    const dirRelative = normalizedRelative.split('/').slice(0, -1).join('/');
    return { replaceable: true, mode: 'file', dirRelative, currentRelative: normalizedRelative };
  }

  if (courseType === 'assessment') {
    if (contentType === 'video_with_excel') {
      return { replaceable: true, mode: 'dir-fixed-name', dirRelative: normalizedRelative, fixedName: `${subCourseID}_video.mp4` };
    }
    if (contentType === 'excel_with_ppt') {
      return { replaceable: true, mode: 'dir-original-name', dirRelative: normalizedRelative, namePrefix: `${subCourseID}_` };
    }
    return { replaceable: false, reason: 'This assessment has no replaceable media file - edit its questions via the question bank below instead.' };
  }

  return { replaceable: false, reason: 'Unknown course type.' };
}

// Replaces the course's main file (training video/ppt/pdf, or the optional
// video/ppt media alongside an assessment). Multipart field name: "courseFile".
app.post('/api/admin/courseFile/:courseID', courseFileUpload, (req, res) => {
  const subCourseID = req.params.courseID;
  const isRefresher = req.query.source === 'refresher';
  const tableName = isRefresher ? 'refresher_subcourses' : 'subcourses';
  const file = req.files && req.files.courseFile && req.files.courseFile[0];
  if (!file) {
    return res.status(400).json({ success: false, error: 'No file uploaded (field name: courseFile)' });
  }

  connection.query(
    `SELECT subCourseID, courseType, contentType, subCoursePath, scormPath FROM ${tableName} WHERE subCourseID = ? LIMIT 1`,
    [subCourseID],
    (error, rows) => {
      if (error) {
        console.error('Error loading course for file replace:', error);
        return res.status(500).json({ success: false, error: 'Database error' });
      }
      if (!rows.length) {
        return res.status(404).json({ success: false, error: 'Course not found' });
      }

      const info = resolveMainCourseFileInfo(rows[0]);
      if (!info.replaceable) {
        return res.status(400).json({ success: false, error: info.reason });
      }

      try {
        if (info.mode === 'file') {
          const oldAbsolute = path.join(__dirname, info.currentRelative);
          const dirAbsolute = path.join(__dirname, info.dirRelative);
          if (!fs.existsSync(dirAbsolute)) {
            fs.mkdirSync(dirAbsolute, { recursive: true });
          }
          const newFileName = `${subCourseID}_${path.basename(file.originalname)}`;
          const newAbsolute = path.join(dirAbsolute, newFileName);
          if (fs.existsSync(oldAbsolute) && path.resolve(oldAbsolute) !== path.resolve(newAbsolute)) {
            fs.unlinkSync(oldAbsolute);
          } else if (fs.existsSync(newAbsolute)) {
            fs.unlinkSync(newAbsolute);
          }
          fs.writeFileSync(newAbsolute, file.buffer);
          const newRelativePath = `${info.dirRelative}/${newFileName}`;

          connection.query(
            `UPDATE ${tableName} SET subCoursePath = ? WHERE subCourseID = ?`,
            [newRelativePath, subCourseID],
            (updateError) => {
              if (updateError) {
                console.error('Error updating subCoursePath after file replace:', updateError);
                return res.status(500).json({ success: false, error: 'File saved but failed to update database record' });
              }
              res.json({ success: true, filePath: newRelativePath });
            }
          );
        } else {
          const dirAbsolute = path.join(__dirname, info.dirRelative);
          if (!fs.existsSync(dirAbsolute)) {
            fs.mkdirSync(dirAbsolute, { recursive: true });
          }
          const fileName = info.mode === 'dir-fixed-name'
            ? info.fixedName
            : `${info.namePrefix}${path.basename(file.originalname)}`;
          const fileAbsolute = path.join(dirAbsolute, fileName);
          fs.writeFileSync(fileAbsolute, file.buffer);
          // The directory path stored in subCoursePath/scormPath is unchanged -
          // no DB update needed for this mode.
          res.json({ success: true, filePath: `${info.dirRelative}/${fileName}` });
        }
      } catch (fsError) {
        console.error('Error replacing course file:', fsError);
        res.status(500).json({ success: false, error: 'Failed to save replacement file' });
      }
    }
  );
});

// Adds a new question to the end of a course's question bank.
app.post('/api/admin/courseQuestions/:courseID', (req, res) => {
  const subCourseID = req.params.courseID;
  const { questionText, option1Text, option2Text, option3Text, option4Text, answerText } = req.body;

  connection.query(
    'SELECT COALESCE(MAX(questionOrder), 0) + 1 AS nextOrder FROM subcourse_questions WHERE subCourseID = ?',
    [subCourseID],
    (orderError, orderRows) => {
      if (orderError) {
        console.error('Error computing next question order:', orderError);
        return res.status(500).json({ success: false, error: 'Database error' });
      }
      const nextOrder = orderRows[0].nextOrder;

      connection.query(
        `INSERT INTO subcourse_questions
          (subCourseID, questionOrder, questionText, option1Text, option2Text, option3Text, option4Text, answerText)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          subCourseID,
          nextOrder,
          questionText || null,
          option1Text || null,
          option2Text || null,
          option3Text || null,
          option4Text || null,
          answerText ? String(answerText).trim().toUpperCase() : null,
        ],
        (insertError, result) => {
          if (insertError) {
            console.error('Error adding question:', insertError);
            return res.status(500).json({ success: false, error: 'Database error' });
          }
          res.json({ success: true, questionID: result.insertId, questionOrder: nextOrder });
        }
      );
    }
  );
});

// Updates one question's text fields (and/or order). Image fields are set
// separately via /api/admin/courseQuestionImage.
app.put('/api/admin/courseQuestions/:courseID/:questionID', (req, res) => {
  const { courseID, questionID } = req.params;
  const { questionText, option1Text, option2Text, option3Text, option4Text, answerText, questionOrder } = req.body;

  const setClauses = [];
  const values = [];
  const setIfPresent = (column, value) => {
    if (value !== undefined) {
      setClauses.push(`${column} = ?`);
      values.push(value);
    }
  };

  setIfPresent('questionText', questionText);
  setIfPresent('option1Text', option1Text);
  setIfPresent('option2Text', option2Text);
  setIfPresent('option3Text', option3Text);
  setIfPresent('option4Text', option4Text);
  setIfPresent('answerText', answerText !== undefined ? String(answerText).trim().toUpperCase() : undefined);
  setIfPresent('questionOrder', questionOrder);

  if (!setClauses.length) {
    return res.status(400).json({ success: false, error: 'No fields to update' });
  }

  values.push(questionID, courseID);
  connection.query(
    `UPDATE subcourse_questions SET ${setClauses.join(', ')} WHERE questionID = ? AND subCourseID = ?`,
    values,
    (error, result) => {
      if (error) {
        console.error('Error updating question:', error);
        return res.status(500).json({ success: false, error: 'Database error' });
      }
      if (!result.affectedRows) {
        return res.status(404).json({ success: false, error: 'Question not found' });
      }
      res.json({ success: true });
    }
  );
});

// Deletes one question from a course's question bank.
app.delete('/api/admin/courseQuestions/:courseID/:questionID', (req, res) => {
  const { courseID, questionID } = req.params;
  connection.query(
    'DELETE FROM subcourse_questions WHERE questionID = ? AND subCourseID = ?',
    [questionID, courseID],
    (error, result) => {
      if (error) {
        console.error('Error deleting question:', error);
        return res.status(500).json({ success: false, error: 'Database error' });
      }
      if (!result.affectedRows) {
        return res.status(404).json({ success: false, error: 'Question not found' });
      }
      res.json({ success: true });
    }
  );
});

// Uploads/replaces an image for one question field. Multipart field name:
// "image". Body field "target" selects which image column to set: 'question',
// 'option1', 'option2', 'option3', or 'option4'.
app.post('/api/admin/courseQuestionImage/:courseID/:questionID', questionImageUpload, (req, res) => {
  const { courseID, questionID } = req.params;
  const target = String(req.body.target || '').trim();
  const allowedTargets = {
    question: 'questionImage',
    option1: 'option1Image',
    option2: 'option2Image',
    option3: 'option3Image',
    option4: 'option4Image',
  };
  const column = allowedTargets[target];
  const file = req.files && req.files.image && req.files.image[0];

  if (!column) {
    return res.status(400).json({ success: false, error: "Invalid target - expected 'question', 'option1', 'option2', 'option3', or 'option4'" });
  }
  if (!file) {
    return res.status(400).json({ success: false, error: 'No image uploaded (field name: image)' });
  }

  const dirAbsolute = path.join(__dirname, 'uploads', 'Question Images', String(courseID));
  if (!fs.existsSync(dirAbsolute)) {
    fs.mkdirSync(dirAbsolute, { recursive: true });
  }
  const fileName = `${questionID}_${target}_${Date.now()}${path.extname(file.originalname) || ''}`;
  fs.writeFileSync(path.join(dirAbsolute, fileName), file.buffer);
  const relativePath = `uploads/Question Images/${courseID}/${fileName}`;

  connection.query(
    `UPDATE subcourse_questions SET ${column} = ? WHERE questionID = ? AND subCourseID = ?`,
    [relativePath, questionID, courseID],
    (error, result) => {
      if (error) {
        console.error('Error saving question image path:', error);
        return res.status(500).json({ success: false, error: 'Database error' });
      }
      if (!result.affectedRows) {
        return res.status(404).json({ success: false, error: 'Question not found' });
      }
      res.json({ success: true, imagePath: relativePath });
    }
  );
});

// Rebuilds {courseID}_quiz.html from the current subcourse_questions rows.
// Only meaningful for courseType = 'assessment' (training-type courses have
// no quiz file). The employee-facing /training/:courseID route just serves
// this static file as-is and is otherwise untouched.
app.post('/api/admin/courseQuestions/:courseID/regenerate', (req, res) => {
  const subCourseID = req.params.courseID;
  const isRefresher = req.query.source === 'refresher';
  const tableName = isRefresher ? 'refresher_subcourses' : 'subcourses';

  connection.query(
    `SELECT subCourseID, subCourseName, courseType, contentType, subCoursePath, scormPath FROM ${tableName} WHERE subCourseID = ? LIMIT 1`,
    [subCourseID],
    (error, rows) => {
      if (error) {
        console.error('Error loading course for quiz regeneration:', error);
        return res.status(500).json({ success: false, error: 'Database error' });
      }
      if (!rows.length) {
        return res.status(404).json({ success: false, error: 'Course not found' });
      }

      const course = rows[0];
      if (course.courseType !== 'assessment') {
        return res.status(400).json({ success: false, error: 'Only assessment-type courses have a quiz to regenerate.' });
      }

      const dirRelative = course.scormPath || course.subCoursePath;
      if (!dirRelative) {
        return res.status(400).json({ success: false, error: 'No course folder on record.' });
      }
      const coursePath = path.join(__dirname, dirRelative);

      connection.query(
        'SELECT * FROM subcourse_questions WHERE subCourseID = ? ORDER BY questionOrder ASC, questionID ASC',
        [subCourseID],
        (qError, questionRows) => {
          if (qError) {
            console.error('Error loading questions for quiz regeneration:', qError);
            return res.status(500).json({ success: false, error: 'Database error' });
          }
          if (!questionRows.length) {
            return res.status(400).json({ success: false, error: 'No questions to regenerate from.' });
          }

          regenerateQuizHTMLFromQuestions(subCourseID, course.subCourseName, coursePath, questionRows, (genError) => {
            if (genError) {
              console.error('Error regenerating quiz HTML:', genError);
              return res.status(500).json({ success: false, error: 'Failed to regenerate quiz file' });
            }
            res.json({ success: true });
          });
        }
      );
    }
  );
});


// // Get the course list on viewscorm page
// app.get('/getViewscormCourseList', (req, res) => {
//   const query = `SELECT id, courseName, courseDate, courseDescription, courseTeacher, scormPath, courseID FROM courses ORDER BY id DESC`;

//   connection.query(query, (error, results) => {
//     if (error) {
//       console.error(error);
//       return res.status(500).send('Internal Server Error');
//     }

//     // Filter the courses based on whether the scormPath exists in the uploads folder
//     const filteredResults = results.filter(course => {
//       const scormFolderPath = path.join(__dirname, course.scormPath); // Full path to the SCORM folder
//       return fs.existsSync(scormFolderPath); // Only keep courses where the folder exists
//     });

//     res.json(filteredResults); // Send the filtered results
//   });
// });




// // Get the course list on viewscorm page
// app.get('/getViewscormCourseList', (req, res) => {
//   const query = `SELECT id, courseName, courseDate, courseDescription, courseTeacher, scormPath, courseID FROM courses ORDER BY id DESC`;

//   connection.query(query, (error, results) => {
//     if (error) {
//       console.error(error);
//       return res.status(500).send('Internal Server Error');
//     }

//     // Filter the courses based on whether the scormPath exists in the uploads folder
//     const filteredResults = results.filter(course => {
//       const scormFolderPath = path.join(__dirname, course.scormPath); // Full path to the SCORM folder
//       return fs.existsSync(scormFolderPath); // Only keep courses where the folder exists
//     });

//     res.json(filteredResults); // Send the filtered results
//   });
// });


// Get the course list on viewscorm page woking 3/10/2025
// app.get('/getViewscormCourseList', (req, res) => {
//   const query = `SELECT id, courseName, courseDate, courseDescription, courseTeacher, scormPath, courseID FROM courses ORDER BY id DESC`;
//   const uniqueID = req.session.user.uniqueID; // Get user's unique ID from session

//   connection.query(query, (error, results) => {
//     if (error) {
//       console.error(error);
//       return res.status(500).send('Internal Server Error');
//     }

//     // Filter courses where SCORM path exists
//     const filteredResults = results.filter(course => {
//       const scormFolderPath = path.join(__dirname, course.scormPath);
//       return fs.existsSync(scormFolderPath);
//     });

//     // Fetch status for each course
//     const statusQueries = filteredResults.map(course => {
//       return new Promise((resolve, reject) => {
//         const statusQuery = `SELECT status1, status2, status3 FROM course_${ course.courseID } WHERE uniqueID = ? `;
//         connection.query(statusQuery, [uniqueID], (err, statusResults) => {
//           if (err) {
//             console.error(err);
//             resolve({ courseID: course.courseID, status: 'No Attempt' }); // Default if error occurs
//           } else if (statusResults.length > 0) {
//             // Check status values and determine last attempt
//             const attempts = [];
//             for (let i = 1; i <= 3; i++) {
//               if (statusResults[0][`status${ i } `]) {
//                 attempts.push(statusResults[0][`status${ i } `]);
//               }
//             }
//             resolve({ courseID: course.courseID, status: attempts.length ? attempts.join(', ') : 'No Attempt' });
//           } else {
//             resolve({ courseID: course.courseID, status: 'No Attempt' });
//           }
//         });
//       });
//     });

//     Promise.all(statusQueries)
//       .then(statusResults => {
//         // Merge status with courses
//         const finalResults = filteredResults.map(course => {
//           const statusObj = statusResults.find(status => status.courseID === course.courseID);
//           return { ...course, status: statusObj ? statusObj.status : 'No Attempt' };
//         });

//         res.json(finalResults);
//       })
//       .catch(error => {
//         console.error(error);
//         res.status(500).send('Error fetching status data');
//       });
//   });
// });


// app.get('/getViewscormCourseList', (req, res) => {
//     // 🎯 CRITICAL CHANGE: Added 'courseTags' to the SELECT statement
//     const query = `SELECT id, courseName, courseDate, courseDescription, courseTeacher, scormPath, courseID, courseTags FROM courses ORDER BY id DESC`;

//     // Ensure the user is logged in before proceeding (as you are relying on req.session.user)
//     if (!req.session || !req.session.user || !req.session.user.uniqueID) {
//         // If the user is not authenticated, return an empty array or an error
//         return res.status(401).json([]); 
//     }
//     const uniqueID = req.session.user.uniqueID; // Get user's unique ID from session

//     connection.query(query, (error, results) => {
//         if (error) {
//             console.error(error);
//             return res.status(500).send('Internal Server Error');
//         }

//         // Filter courses where SCORM path exists
//         const filteredResults = results.filter(course => {
//             // Note: __dirname might need adjustment depending on where this route is defined
//             const scormFolderPath = path.join(__dirname, course.scormPath);
//             return fs.existsSync(scormFolderPath);
//         });

//         // Fetch status for each course
//         const statusQueries = filteredResults.map(course => {
//             return new Promise((resolve, reject) => {
//                 const statusQuery = `SELECT status1, status2, status3 FROM course_${ course.courseID } WHERE uniqueID = ? `;
//                 connection.query(statusQuery, [uniqueID], (err, statusResults) => {
//                     if (err) {
//                         console.error(`Error fetching status for course ${ course.courseID }: `, err);
//                         resolve({ courseID: course.courseID, status: 'No Attempt' }); // Default if error occurs
//                     } else if (statusResults.length > 0) {
//                         // Check status values and determine last attempt
//                         const attempts = [];
//                         for (let i = 1; i <= 3; i++) {
//                             if (statusResults[0][`status${ i } `]) {
//                                 attempts.push(statusResults[0][`status${ i } `]);
//                             }
//                         }
//                         resolve({ courseID: course.courseID, status: attempts.length ? attempts.join(', ') : 'No Attempt' });
//                     } else {
//                         resolve({ courseID: course.courseID, status: 'No Attempt' });
//                     }
//                 });
//             });
//         });

//         Promise.all(statusQueries)
//             .then(statusResults => {
//                 // Merge status with courses
//                 const finalResults = filteredResults.map(course => {
//                     const statusObj = statusResults.find(status => status.courseID === course.courseID);
//                     return { ...course, status: statusObj ? statusObj.status : 'No Attempt' };
//                 });

//                 res.json(finalResults);
//             })
//             .catch(error => {
//                 console.error('Error in Promise.all for status queries:', error);
//                 res.status(500).send('Error fetching status data');
//             });
//     });
// });

app.get('/getViewscormCourseList', (req, res) => {

  // 1. Authentication Check
  if (!req.session || !req.session.user || !req.session.user.uniqueID) {
    console.warn('Attempt to access course list without authentication. Returning 401.');
    return res.status(401).json([]);
  }
  const uniqueID = req.session.user.uniqueID;

  // Level 1 courses require no assignment/enrollment at all - they are always
  // visible to every logged-in user. Level 2 (and above) only become visible
  // once a matching enrollstatus row exists (assigned via the Enrollment page,
  // see /api/enrollstatus/assignProcess). The two halves below are combined
  // with a plain UNION, which also de-duplicates identical rows for users who
  // happen to have both.
  const normalizedQuery = `
    SELECT DISTINCT
      sc.subCourseID AS id,
      sc.subCourseName AS courseName,
      sc.subCourseDate AS courseDate,
      sc.subCourseDescription AS courseDescription,
      sc.subCourseTeacher AS courseTeacher,
      COALESCE(sc.scormPath, sc.subCoursePath) AS scormPath,
      sc.subCourseID AS courseID,
      sc.subCourseLevel AS level,
      sc.courseType,
      sc.contentType,
      'regular' AS source,
      COALESCE(
        (
          SELECT cg.status
          FROM coursegrades cg
          WHERE cg.uniqueID = ?
            AND cg.subCourseID = sc.subCourseID
          ORDER BY cg.id DESC
          LIMIT 1
        ),
        (
          SELECT pe.finalResult
          FROM practicalevaluations pe
          WHERE pe.uniqueID = ?
            AND pe.subCourseID = sc.subCourseID
            AND pe.evaluationStatus = 'Submitted'
          LIMIT 1
        ),
        (
          SELECT tg.status
          FROM traininggrades tg
          WHERE tg.uniqueID = ?
            AND tg.subCourseID = sc.subCourseID
          ORDER BY tg.id DESC
          LIMIT 1
        ),
        'No Attempt'
      ) AS status
    FROM subcourses sc
    WHERE sc.subCourseLevel = 'Level 1'
      AND (
        sc.subCourseRoles IS NULL
        OR sc.subCourseRoles = ''
        OR FIND_IN_SET(
          (SELECT u.uRole FROM users u WHERE u.uniqueID = ? LIMIT 1),
          sc.subCourseRoles
        )
      )

    UNION

    SELECT DISTINCT
      sc.subCourseID AS id,
      sc.subCourseName AS courseName,
      sc.subCourseDate AS courseDate,
      sc.subCourseDescription AS courseDescription,
      sc.subCourseTeacher AS courseTeacher,
      COALESCE(sc.scormPath, sc.subCoursePath) AS scormPath,
      sc.subCourseID AS courseID,
      sc.subCourseLevel AS level,
      sc.courseType,
      sc.contentType,
      'regular' AS source,
      COALESCE(
        (
          SELECT cg.status
          FROM coursegrades cg
          WHERE cg.uniqueID = es.uniqueID
            AND cg.subCourseID = sc.subCourseID
          ORDER BY cg.id DESC
          LIMIT 1
        ),
        (
          SELECT pe.finalResult
          FROM practicalevaluations pe
          WHERE pe.uniqueID = es.uniqueID
            AND pe.subCourseID = sc.subCourseID
            AND pe.evaluationStatus = 'Submitted'
          LIMIT 1
        ),
        (
          SELECT tg.status
          FROM traininggrades tg
          WHERE tg.uniqueID = es.uniqueID
            AND tg.subCourseID = sc.subCourseID
          ORDER BY tg.id DESC
          LIMIT 1
        ),
        'No Attempt'
      ) AS status
    FROM enrollstatus es
    JOIN subcourses sc
      ON sc.deptID = es.deptID
     AND (es.areaID IS NULL OR sc.areaID = es.areaID)
     AND (es.mCourseID IS NULL OR sc.mCourseID = es.mCourseID)
     AND (es.coMCourseID IS NULL OR sc.coMCourseID = es.coMCourseID)
     AND (es.subCourseID IS NULL OR sc.subCourseID = es.subCourseID)
     AND (es.stationID = 0 OR sc.stationID = 0 OR sc.stationID = es.stationID)
    WHERE es.uniqueID = ?
      AND COALESCE(es.enrollStatus, 'Active') IN ('Active', 'active', 'Enrolled', 'enrolled')
      AND (
        sc.subCourseLevel IS NULL
        OR sc.subCourseLevel IN ('Level 1', 'Level 2', 'default')
        OR (
          sc.subCourseLevel = 'Level 3'
          AND EXISTS (
            SELECT 1 FROM skillmatrix_station_skills sms
            WHERE sms.uniqueID = es.uniqueID
              AND sms.deptID = es.deptID
              AND sms.areaID = es.areaID
              AND sms.mCourseID = es.mCourseID
              AND (sms.stationID = 0 OR es.stationID = 0 OR sms.stationID = es.stationID)
              AND sms.requiredLevel >= 3
          )
          AND EXISTS (
            SELECT 1 FROM l2completedusers l2
            WHERE l2.uniqueID = es.uniqueID
              AND l2.mCourseID = es.mCourseID
              AND (l2.stationID = 0 OR es.stationID = 0 OR l2.stationID = es.stationID)
              AND l2.l2Status = 'Pass'
          )
        )
        OR (
          sc.subCourseLevel = 'Level 4'
          AND EXISTS (
            SELECT 1 FROM skillmatrix_station_skills sms
            WHERE sms.uniqueID = es.uniqueID
              AND sms.deptID = es.deptID
              AND sms.areaID = es.areaID
              AND sms.mCourseID = es.mCourseID
              AND (sms.stationID = 0 OR es.stationID = 0 OR sms.stationID = es.stationID)
              AND sms.requiredLevel >= 4
          )
          AND EXISTS (
            SELECT 1 FROM l3completedusers l3
            WHERE l3.uniqueID = es.uniqueID
              AND l3.mCourseID = es.mCourseID
              AND (l3.stationID = 0 OR es.stationID = 0 OR l3.stationID = es.stationID)
              AND l3.l3Status = 'Pass'
          )
        )
      )

    UNION

    SELECT DISTINCT
      sc.subCourseID AS id,
      sc.subCourseName AS courseName,
      sc.subCourseDate AS courseDate,
      sc.subCourseDescription AS courseDescription,
      sc.subCourseTeacher AS courseTeacher,
      COALESCE(sc.scormPath, sc.subCoursePath) AS scormPath,
      sc.subCourseID AS courseID,
      sc.subCourseLevel AS level,
      sc.courseType,
      sc.contentType,
      'regular' AS source,
      COALESCE(
        (
          SELECT cg.status
          FROM coursegrades cg
          WHERE cg.uniqueID = ?
            AND cg.subCourseID = sc.subCourseID
          ORDER BY cg.id DESC
          LIMIT 1
        ),
        (
          SELECT pe.finalResult
          FROM practicalevaluations pe
          WHERE pe.uniqueID = ?
            AND pe.subCourseID = sc.subCourseID
            AND pe.evaluationStatus = 'Submitted'
          LIMIT 1
        ),
        (
          SELECT tg.status
          FROM traininggrades tg
          WHERE tg.uniqueID = ?
            AND tg.subCourseID = sc.subCourseID
          ORDER BY tg.id DESC
          LIMIT 1
        ),
        'No Attempt'
      ) AS status
    FROM subcourses sc
    WHERE sc.mCourseID IS NULL
      AND sc.subCourseLevel IN ('Level 2', 'Level 3', 'Level 4')
      AND EXISTS (
        SELECT 1 FROM enrollstatus es2
        WHERE es2.uniqueID = ?
          AND es2.coMCourseID IS NULL AND es2.subCourseID IS NULL
          AND COALESCE(es2.enrollStatus, 'Active') IN ('Active', 'active', 'Enrolled', 'enrolled')
          AND (
            sc.subCourseLevel = 'Level 2'
            OR (
              sc.subCourseLevel = 'Level 3'
              AND EXISTS (
                SELECT 1 FROM skillmatrix_station_skills sms
                WHERE sms.uniqueID = es2.uniqueID
                  AND sms.deptID = es2.deptID
                  AND sms.areaID = es2.areaID
                  AND sms.mCourseID = es2.mCourseID
                  AND (sms.stationID = 0 OR es2.stationID = 0 OR sms.stationID = es2.stationID)
                  AND sms.requiredLevel >= 3
              )
              AND EXISTS (
                SELECT 1 FROM l2completedusers l2
                WHERE l2.uniqueID = es2.uniqueID
                  AND l2.mCourseID = es2.mCourseID
                  AND (l2.stationID = 0 OR es2.stationID = 0 OR l2.stationID = es2.stationID)
                  AND l2.l2Status = 'Pass'
              )
            )
            OR (
              sc.subCourseLevel = 'Level 4'
              AND EXISTS (
                SELECT 1 FROM skillmatrix_station_skills sms
                WHERE sms.uniqueID = es2.uniqueID
                  AND sms.deptID = es2.deptID
                  AND sms.areaID = es2.areaID
                  AND sms.mCourseID = es2.mCourseID
                  AND (sms.stationID = 0 OR es2.stationID = 0 OR sms.stationID = es2.stationID)
                  AND sms.requiredLevel >= 4
              )
              AND EXISTS (
                SELECT 1 FROM l3completedusers l3
                WHERE l3.uniqueID = es2.uniqueID
                  AND l3.mCourseID = es2.mCourseID
                  AND (l3.stationID = 0 OR es2.stationID = 0 OR l3.stationID = es2.stationID)
                  AND l3.l3Status = 'Pass'
              )
            )
          )
      )

    UNION

    SELECT DISTINCT
      rsc.subCourseID AS id,
      rsc.subCourseName AS courseName,
      rsc.subCourseDate AS courseDate,
      rsc.subCourseDescription AS courseDescription,
      rsc.subCourseTeacher AS courseTeacher,
      COALESCE(rsc.scormPath, rsc.subCoursePath) AS scormPath,
      rsc.subCourseID AS courseID,
      'Refresher' AS level,
      rsc.courseType,
      rsc.contentType,
      'refresher' AS source,
      COALESCE(
        (
          SELECT rcg.status
          FROM refresher_coursegrades rcg
          WHERE rcg.uniqueID = ?
            AND rcg.subCourseID = rsc.subCourseID
          ORDER BY rcg.id DESC
          LIMIT 1
        ),
        (
          SELECT rtg.status
          FROM refresher_traininggrades rtg
          WHERE rtg.uniqueID = ?
            AND rtg.subCourseID = rsc.subCourseID
          ORDER BY rtg.id DESC
          LIMIT 1
        ),
        'No Attempt'
      ) AS status
    FROM refresher_subcourses rsc
    WHERE EXISTS (
      SELECT 1
      FROM skillmatrix_refresher_assignments sra
      WHERE sra.uniqueID = ?
        AND sra.planMonth = MONTH(CURDATE())
        AND sra.planYear = YEAR(CURDATE())
        AND COALESCE(sra.planCode, 'RT') = 'RT'
        AND sra.status IN ('Planned', 'planned')
    )

    ORDER BY courseName
  `;

  connection.query(normalizedQuery, [uniqueID, uniqueID, uniqueID, uniqueID, uniqueID, uniqueID, uniqueID, uniqueID, uniqueID, uniqueID, uniqueID, uniqueID], async (normalizedError, normalizedCourses) => {
    if (!normalizedError) {
      let visibleCourses = normalizedCourses.filter(course => {
        if (!course.scormPath) return true;
        return fs.existsSync(path.join(__dirname, course.scormPath));
      });

      // A historical Pass belongs to the original certification attempt. Once
      // a refresher cycle is due, expose the current-cycle state separately so
      // the browser can reopen courses that have not been passed in this cycle.
      try {
        const refresher = await computeUserRefresherStatus(uniqueID);
        const refresherByCourse = new Map(
          (refresher.due ? refresher.courses : []).map(c => [Number(c.subCourseID), c])
        );
        visibleCourses = visibleCourses.map(course => {
          const currentCycle = refresherByCourse.get(Number(course.courseID));
          if (!currentCycle || course.source === 'refresher') return course;
          return {
            ...course,
            refresherRequired: true,
            refresherCompleted: !!currentCycle.refreshed,
            refresherLocked: !!currentCycle.locked,
            refresherStatus: currentCycle.currentStatus || 'No Attempt'
          };
        });
      } catch (refresherError) {
        console.error('Could not attach refresher state to My Courses:', refresherError);
      }

      try {
        const variantCourses = visibleCourses.filter(course => ['training','assessment','scorm'].includes(course.courseType));
        if (variantCourses.length) {
          const [languageRows] = await connection.promise().query(
            `SELECT subCourseID, courseSource, languageName, filePath, contentType
             FROM training_material_languages
             WHERE subCourseID IN (?) ORDER BY id`,
            [variantCourses.map(course => course.courseID)]
          );
          visibleCourses = visibleCourses.map(course => ({
            ...course,
            languages: ['training','assessment','scorm'].includes(course.courseType)
              ? languageRows
                  .filter(row => Number(row.subCourseID) === Number(course.courseID)
                    && row.courseSource === (course.source === 'refresher' ? 'refresher' : 'regular'))
                  .map(row => ({ language: row.languageName, filePath: row.filePath, contentType: row.contentType }))
              : []
          }));
        }
      } catch (languageError) {
        console.error('Could not attach training languages to My Courses:', languageError);
      }

      console.log(`Returning ${visibleCourses.length} normalized enrolled courses for user ${uniqueID}`);
      return res.json(visibleCourses);
    }

    if (!shouldFallbackToLegacySchema(normalizedError)) {
      console.error('Error fetching normalized enrolled courses:', normalizedError);
      return res.status(500).send('Internal Server Error fetching courses.');
    }

    loadLegacyViewscormCourseList(uniqueID, res);
  });
});

function loadLegacyViewscormCourseList(uniqueID, res) {
  const query = `SELECT id, courseName, courseDate, courseDescription, courseTeacher, scormPath, courseID, level FROM courses ORDER BY id DESC`;

  connection.query(query, (error, allCourses) => {
    if (error) {
      console.error(error);
      return res.status(500).send('Internal Server Error fetching courses.');
    }

    // 2. Process all courses for enrollment check, file existence, and status
    const courseChecks = allCourses.map(course => {
      return new Promise((resolve, reject) => {

        // First, check if the SCORM path exists
        const scormFolderPath = path.join(__dirname, course.scormPath);
        if (!fs.existsSync(scormFolderPath)) {
          console.warn(`SCORM path missing for course ${course.courseID}. Excluding.`);
          return resolve(null);
        }

        // 3. ENROLLMENT CHECK
        const enrollmentCheckQuery = `SELECT uniqueID FROM course_${course.courseID} WHERE uniqueID = ? LIMIT 1`;

        connection.query(enrollmentCheckQuery, [uniqueID], (err, enrollmentResults) => {
          if (err) {
            console.error(`DB Error during enrollment check for course ${course.courseID}: `, err.message);
            return resolve(null);
          }

          if (enrollmentResults.length === 0) {
            console.log(`User ${uniqueID} NOT enrolled in course ${course.courseID} (${course.courseName}). Excluding.`);
            return resolve(null);
          }

          console.log(`User ${uniqueID} IS enrolled in course ${course.courseID} (${course.courseName}). Proceeding to status check.`);

          // 5. STATUS FETCH - FIXED VERSION
          const getColumnsQuery = `SHOW COLUMNS FROM course_${course.courseID} LIKE 'status%'`;

          connection.query(getColumnsQuery, (colErr, columns) => {
            if (colErr) {
              console.error(`Error getting columns for course ${course.courseID}:`, colErr);
              return resolve({ ...course, status: 'Error Loading Status' });
            }

            // 🔧 FIX: Sort status columns to ensure correct order (status, status1, status2, etc.)
            const statusColumns = columns
              .map(col => col.Field)
              .sort((a, b) => {
                // Extract numbers from column names for proper sorting
                const numA = a === 'status' ? 0 : parseInt(a.replace('status', '')) || 0;
                const numB = b === 'status' ? 0 : parseInt(b.replace('status', '')) || 0;
                return numA - numB;
              });

            if (statusColumns.length === 0) {
              console.warn(`No status columns found for course ${course.courseID}`);
              return resolve({ ...course, status: 'No Attempt' });
            }

            const selectColumns = statusColumns.join(', ');
            const statusQuery = `SELECT ${selectColumns} FROM course_${course.courseID} WHERE uniqueID = ?`;

            connection.query(statusQuery, [uniqueID], (statusErr, statusResults) => {
              if (statusErr) {
                console.error(`Error fetching status for course ${course.courseID}:`, statusErr);
                return resolve({ ...course, status: 'Error Loading Status' });
              }

              let status = 'No Attempt';
              if (statusResults.length > 0) {
                const attempts = [];

                // Collect all non-null status values IN THE CORRECT ORDER
                statusColumns.forEach(colName => {
                  const value = statusResults[0][colName];
                  if (value && value !== null && value.trim() !== '') {
                    attempts.push(value.trim().toLowerCase());
                  }
                });

                // Get the LAST (most recent) status
                if (attempts.length > 0) {
                  const lastStatus = attempts[attempts.length - 1];

                  // 🔧 STATUS MAPPING LOGIC
                  if (lastStatus === 'passed' || lastStatus === 'failed' || lastStatus === 'fail') {
                    status = 'Completed';
                  } else if (lastStatus === 'unknown' || lastStatus === 'suspend' || lastStatus === 'suspended') {
                    status = 'Attempted';
                  } else if (lastStatus === 'incomplete' || lastStatus === 'browsed') {
                    status = 'Attempted';
                  } else {
                    // For any other status, show it as is (capitalized)
                    status = lastStatus.charAt(0).toUpperCase() + lastStatus.slice(1);
                  }
                }

                console.log(`✅ Course ${course.courseID} - Attempts array: [${attempts.join(', ')}] → Last status: ${attempts[attempts.length - 1]} → Mapped: ${status}`);
              }

              resolve({ ...course, status });
            });
          });
        });
      });
    });

    // 3. Wait for all course checks to complete
    Promise.all(courseChecks)
      .then(results => {
        // Filter out null values (courses user is not enrolled in or missing files)
        const enrolledCourses = results.filter(course => course !== null);

        console.log(`📚 Returning ${enrolledCourses.length} enrolled courses for user ${uniqueID}`);
        res.json(enrolledCourses);
      })
      .catch(err => {
        console.error('Error processing courses:', err);
        res.status(500).send('Error processing course list.');
      });
  });
}






// app.get('/getUserCourseTags', (req, res) => {
//     // 🎯 CRITICAL: Check for authentication using your existing session mechanism
//     if (!req.session || !req.session.user || !req.session.user.uniqueID) {
//         // Must return 401 or an empty object if unauthenticated
//         return res.status(401).json({ error: 'User not authenticated' });
//     }

//     const uniqueID = req.session.user.uniqueID;

//     // Query the users table for the courseTags column
//     const query = `SELECT courseTags FROM users WHERE uniqueID = ? LIMIT 1`;

//     connection.query(query, [uniqueID], (error, results) => {
//         if (error) {
//             console.error('Error fetching user course tags from DB:', error);
//             return res.status(500).json({ error: 'Internal Server Error fetching user tags' });
//         }

//         if (results.length > 0 && results[0].courseTags) {
//             // Send the raw comma-separated string back
//             res.json({ courseTags: results[0].courseTags });
//         } else {
//             // User found, but no tags defined (send empty string)
//             res.json({ courseTags: '' });
//         }
//     });
// });





// Route to delete a course from the database
app.delete('/deleteCourse', (req, res) => {
  const { courseID } = req.body;

  // Check if courseID is provided
  if (!courseID) {
    return res.status(400).send('Course ID is required');
  }

  // Perform deletion operation in the database
  const deleteCourseQuery = 'DELETE FROM courses WHERE courseID = ?';
  connection.query(deleteCourseQuery, [courseID], (error, results) => {
    if (error) {
      console.error('Error deleting course:', error);
      return res.status(500).send('Internal Server Error');
    }

    // Drop the associated course table dynamically
    const dropTableQuery = `DROP TABLE IF EXISTS course_${courseID} `;
    connection.query(dropTableQuery, (dropError) => {
      if (dropError) {
        console.error('Error dropping associated course table:', dropError);
        return res.status(500).send('Error deleting associated course table');
      }

      console.log(`Table course_${courseID} deleted successfully`);

      // Delete the associated SCORM package folder
      const scormFolderPath = path.join(__dirname, 'scorm', `course_${courseID} `);
      if (fs.existsSync(scormFolderPath)) {
        fs.rmdirSync(scormFolderPath, { recursive: true }); // Delete the folder recursively
        console.log('SCORM package deleted successfully');
      }

      console.log('Course deleted successfully');
      res.sendStatus(200);
    });
  });
});






// Get the course ID associated with the latest uploaded SCORM package
app.get('/getScormCourseID', (req, res) => {
  // First, execute the database query to get the latest course ID
  const query = `SELECT courseID FROM courses ORDER BY id DESC LIMIT 1`;
  connection.query(query, (error, results) => {
    if (error) {
      console.error(error);
      return res.status(500).send('Internal Server Error');
    }

    if (results.length > 0) {
      const courseID = results[0].courseID;
      res.json({ courseID });
    } else {
      res.status(404).send('No course ID found');
    }
  });
});


// Define the GET endpoint for /getUsedCourseIDs
app.get('/getUsedCourseIDs', (req, res) => {
  // Query to fetch used course IDs from the database
  const query = 'SELECT DISTINCT courseID FROM courses'; // Assuming 'courses' is your table name

  // Execute the query
  connection.query(query, (error, results) => {
    if (error) {
      // Installs that have fully migrated to the normalized subcourses
      // schema (see "Legacy courses table not found" at startup) no longer
      // have this legacy table at all. The Course ID this endpoint feeds
      // (public/index.html's readonly+required "Course ID" box) is purely
      // cosmetic now anyway - the actual save path (insertNormalizedSubcourseFromUpload)
      // uses subcourses' own auto-increment subCourseID and ignores it. So
      // degrade to "no used IDs" instead of failing the request - a 500
      // here left that readonly+required field permanently empty, which
      // made the whole SCORM upload form unsubmittable.
      if (error.code === 'ER_NO_SUCH_TABLE') {
        console.log('Legacy courses table not found; returning empty used-course-ID list');
        return res.json({ usedCourseIDs: [] });
      }
      console.error('Error fetching used course IDs:', error);
      res.status(500).json({ error: 'Internal server error' });
      return;
    }

    // Extract course IDs from the query results
    const usedCourseIDs = results.map(row => row.courseID);

    // Send the used course IDs as a JSON response
    res.json({ usedCourseIDs });
  });
});



// Employee login route
app.post('/employeelogin', (req, res) => {
  const { username, password } = req.body;
  connection.query('SELECT * FROM users WHERE uName = ? AND uPass = ?', [username, password], (error, results) => {
    if (error) {
      console.error('Error in database query:', error);
      return res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
    if (results.length > 0) {
      // User found, login successful
      const user = results[0];
      req.session.user = { username: user.uName, uniqueID: user.uniqueID }; // Extract uniqueID from the query result
      const currentDate = new Date();

      // Update lastLoggedIn column
      connection.query('UPDATE users SET lastLoggedIn = ? WHERE uName = ?', [currentDate, username], (updateError) => {
        if (updateError) {
          console.error('Error updating lastLoggedIn:', updateError);
          return res.status(500).json({ success: false, message: 'Failed to update login time' });
        }
        console.log('Login time updated successfully');
        return res.json({ success: true });
      });
    } else {
      // No matching user found or incorrect password
      console.error('Invalid username or password');
      return res.status(401).json({ success: false, message: 'Invalid username or password' });
    }
  });
});

// In index.js (or wherever your Express routes are defined)

app.post('/update-data', (req, res) => {
  const { uniqueID, LisenceIssue, Level } = req.body;

  console.log("Received data:", { uniqueID, LisenceIssue, Level });

  const query = `UPDATE users SET licenseIssueDate = ?, skillLevel = ? WHERE uniqueID = ? `;
  connection.query(query, [LisenceIssue, Level, uniqueID], (updateError, results) => {
    if (updateError) {
      console.error('Error updating database:', updateError);
      return res.status(500).json({ success: false, message: 'Failed to update database' });
    }
    console.log('Database updated successfully');
    return res.json({ success: true });
  });
});



app.get('/getUserCompletedTag', async (req, res) => {
  const { uniqueID } = req.query;

  if (!uniqueID) {
    return res.status(400).json({ 
      success: false, 
      message: 'uniqueID is required' 
    });
  }

  try {
    // ✅ FIXED: Use c.level directly since it stores the tag name
    // No need for complex JOIN - level column already has the tag name
    const coursesQuery = `
      SELECT 
        c.courseID, 
        c.courseName, 
        c.mCourseName, 
        c.level as courseTag
      FROM courses c
      WHERE c.courseID IS NOT NULL
    `;

    connection.query(coursesQuery, async (err, courses) => {
      if (err) {
        console.error('Error fetching courses:', err);
        return res.status(500).json({ 
          success: false, 
          message: 'Database error' 
        });
      }

      console.log(`Found ${courses.length} courses`);

      // Step 2: For each course, check if user has passed (score >= 60)
      const passedCourses = [];
      
      for (const course of courses) {
        const tableName = `course_${course.courseID}`;
        
        // ✅ FIXED: Query to get the LATEST posttest score
        const scoreQuery = `
          SELECT 
            COALESCE(
              NULLIF(TRIM(course_${course.courseID}_Posttest27), ''),
              NULLIF(TRIM(course_${course.courseID}_Posttest26), ''),
              NULLIF(TRIM(course_${course.courseID}_Posttest25), ''),
              NULLIF(TRIM(course_${course.courseID}_Posttest24), ''),
              NULLIF(TRIM(course_${course.courseID}_Posttest23), ''),
              NULLIF(TRIM(course_${course.courseID}_Posttest22), ''),
              NULLIF(TRIM(course_${course.courseID}_Posttest21), ''),
              NULLIF(TRIM(course_${course.courseID}_Posttest20), ''),
              NULLIF(TRIM(course_${course.courseID}_Posttest19), ''),
              NULLIF(TRIM(course_${course.courseID}_Posttest18), ''),
              NULLIF(TRIM(course_${course.courseID}_Posttest17), ''),
              NULLIF(TRIM(course_${course.courseID}_Posttest16), ''),
              NULLIF(TRIM(course_${course.courseID}_Posttest15), ''),
              NULLIF(TRIM(course_${course.courseID}_Posttest14), ''),
              NULLIF(TRIM(course_${course.courseID}_Posttest13), ''),
              NULLIF(TRIM(course_${course.courseID}_Posttest12), ''),
              NULLIF(TRIM(course_${course.courseID}_Posttest11), ''),
              NULLIF(TRIM(course_${course.courseID}_Posttest10), ''),
              NULLIF(TRIM(course_${course.courseID}_Posttest9), ''),
              NULLIF(TRIM(course_${course.courseID}_Posttest8), ''),
              NULLIF(TRIM(course_${course.courseID}_Posttest7), ''),
              NULLIF(TRIM(course_${course.courseID}_Posttest6), ''),
              NULLIF(TRIM(course_${course.courseID}_Posttest5), ''),
              NULLIF(TRIM(course_${course.courseID}_Posttest4), ''),
              NULLIF(TRIM(course_${course.courseID}_Posttest3), ''),
              NULLIF(TRIM(course_${course.courseID}_Posttest2), ''),
              NULLIF(TRIM(course_${course.courseID}_Posttest1), '')
            ) as posttest
          FROM ${tableName} 
          WHERE uniqueID = ? 
          LIMIT 1
        `;

        try {
          const score = await new Promise((resolve, reject) => {
            connection.query(scoreQuery, [uniqueID], (error, results) => {
              if (error) {
                console.warn(`Table ${tableName} might not exist or error occurred:`, error.message);
                resolve(null);
              } else if (results.length > 0 && results[0].posttest !== null) {
                resolve(parseFloat(results[0].posttest));
              } else {
                resolve(null);
              }
            });
          });

          // ✅ If user passed this course (score >= 60)
          if (score !== null && score >= 60) {
            passedCourses.push({
              courseID: course.courseID,
              courseName: course.courseName,
              mCourseName: course.mCourseName,
              courseTag: course.courseTag,
              score: score
            });
          }
        } catch (error) {
          console.error(`Error checking ${tableName}:`, error);
        }
      }

      console.log(`User ${uniqueID} passed courses:`, passedCourses);

      // Step 3: Group passed courses by Main Course + Tag combination
      const tagGroups = {};
      
      passedCourses.forEach(course => {
        const key = `${course.mCourseName}|${course.courseTag}`;
        if (!tagGroups[key]) {
          tagGroups[key] = {
            mCourseName: course.mCourseName,
            courseTag: course.courseTag,
            passedCourses: [],
            totalCoursesInTag: 0
          };
        }
        tagGroups[key].passedCourses.push(course);
      });

      // Step 4: Find total courses for each tag to check completion
      for (const key in tagGroups) {
        const [mCourseName, courseTag] = key.split('|');
        
        // ✅ FIXED: No JOIN needed - just filter by level column
        const totalQuery = `
          SELECT COUNT(*) as total
          FROM courses
          WHERE mCourseName = ? AND level = ?
        `;

        const total = await new Promise((resolve, reject) => {
          connection.query(totalQuery, [mCourseName, courseTag], (error, results) => {
            if (error) {
              console.error('Error counting total courses:', error);
              resolve(0);
            } else {
              resolve(results[0].total);
            }
          });
        });

        tagGroups[key].totalCoursesInTag = total;
      }

      console.log('Tag completion status:', tagGroups);

      // Step 5: Find first fully completed tag
      let completedTag = null;

      for (const key in tagGroups) {
        const group = tagGroups[key];
        if (group.passedCourses.length === group.totalCoursesInTag && 
            group.totalCoursesInTag > 0) {
          completedTag = {
            mCourseName: group.mCourseName,
            courseTag: group.courseTag,
            passedCourses: group.passedCourses.length,
            totalCourses: group.totalCoursesInTag
          };
          break; // Take first completed tag
        }
      }

      // Step 6: Return result
      if (completedTag) {
        return res.json({
          success: true,
          hasCompletedTag: true,
          mCourseName: completedTag.mCourseName,
          courseTag: completedTag.courseTag,
          details: {
            passedCourses: completedTag.passedCourses,
            totalCourses: completedTag.totalCourses,
            allPassedCourses: passedCourses
          }
        });
      } else {
        return res.json({
          success: true,
          hasCompletedTag: false,
          message: 'User has not completed all courses in any single tag',
          passedCourses: passedCourses,
          tagGroups: tagGroups
        });
      }
    });

  } catch (error) {
    console.error('Error in getUserCompletedTag:', error);
    return res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
});


// Issues/updates a user's license (certificate) record. Simplified flow:
// no more Level/Tag or Main Course dropdown - the level is now implicit
// (the admin reached this page via the Certificate button on a specific
// Grades Report tab), and "department" is no longer overwritten with a
// main-course name. Admin-only; does not touch employee login or
// course-attempting/SCORM code.
app.post('/update-license-issue', (req, res) => {
  const rawUniqueID = req.body.uniqueID;
  const { LisenceIssue, Level, photo, deptID, areaID, mCourseID, stationID } = req.body;
  const uniqueID = typeof rawUniqueID === 'string' ? rawUniqueID.trim() : rawUniqueID;
  const levelNumber = Number(String(Level || '').match(/[1-4]/)?.[0]);

  if (!uniqueID || !LisenceIssue || !levelNumber) {
    console.error('Missing fields for license update:', req.body);
    return res.status(400).json({ success: false, error: 'Missing uniqueID, license date, or level.' });
  }

  console.log("Updating license with:", { uniqueID, LisenceIssue, Level, photo });

  // NOTE: the live `users` schema (post harman-architecture migration) uses
  // lowercase/camelCase column names - licenseIssueDate and skillLevel - not
  // the legacy LisenceIssueDate/Level names used elsewhere in older code.
  const query = `UPDATE users SET licenseIssueDate = ?, skillLevel = ?, photo = COALESCE(?, photo) WHERE uniqueID = ?`;

  connection.query(query, [LisenceIssue, `Level ${levelNumber}`, photo || null, uniqueID], async (updateError, results) => {
      if (updateError) {
        console.error('Error updating database:', updateError);
        return res.status(500).json({
          success: false,
          message: 'Failed to update database'
        });
      }

      if (results.affectedRows === 0) {
        return res.status(404).json({
          success: false,
          error: 'User not found in database'
        });
      }

      try {
        const db = connection.promise();
        // Capture an active refresher before changing the certificate date and
        // clearing its cycle. This keeps a permanent training-date audit for
        // the master report; ordinary first-time certification has no cycle
        // and therefore creates no refresher-history row.
        const [activeCycleRows] = await db.query(
          `SELECT levelNumber, certificationDate
           FROM refresher_cycles WHERE uniqueID = ? LIMIT 1`,
          [uniqueID]
        );
        const activeCycle = activeCycleRows[0] || null;
        if (levelNumber === 1) {
          const [levelResult] = await db.query(
            `UPDATE l1completedusers
             SET levelDate = ?
             WHERE uniqueID = ? AND l1Status = 'Pass'`,
            [LisenceIssue, uniqueID]
          );
          if (!levelResult.affectedRows) {
            return res.status(409).json({ success: false, error: 'Level 1 must be acknowledged before its certificate can be issued.' });
          }
        } else {
          const tableName = `l${levelNumber}completedusers`;
          const statusColumn = `l${levelNumber}Status`;
          const filters = ['uniqueID = ?', `${statusColumn} = 'Pass'`];
          const values = [uniqueID];
          if (mCourseID) {
            filters.push('mCourseID = ?');
            values.push(Number(mCourseID));
          }
          if (stationID !== undefined && stationID !== null && stationID !== '') {
            filters.push('stationID = ?');
            values.push(Number(stationID));
          }
          const [rows] = await db.query(
            `SELECT id FROM ${tableName}
             WHERE ${filters.join(' AND ')}
             ORDER BY acknowledgeDate DESC, id DESC LIMIT 1`,
            values
          );
          if (!rows.length) {
            return res.status(409).json({ success: false, error: `Level ${levelNumber} must be acknowledged before its certificate can be issued.` });
          }
          await db.query(`UPDATE ${tableName} SET levelDate = ? WHERE id = ?`, [LisenceIssue, rows[0].id]);
        }

        if (activeCycle && Number(activeCycle.levelNumber) === levelNumber) {
          await db.query(
            `INSERT INTO refresher_completion_history
               (uniqueID, levelNumber, previousCertificationDate, refresherCompletedDate, renewedCertificationDate)
             VALUES (?, ?, ?, CURDATE(), ?)`,
            [uniqueID, levelNumber, activeCycle.certificationDate, LisenceIssue]
          );
        }

        await db.query(
          `DELETE FROM refresher_course_locks WHERE uniqueID = ?`,
          [uniqueID]
        );
        await db.query(
          `DELETE FROM refresher_cycles WHERE uniqueID = ?`,
          [uniqueID]
        );
        console.log(`Level ${levelNumber} license date saved as refresher-cycle start for user ${uniqueID}`);
        return res.json({ success: true, level: levelNumber, licenseIssueDate: LisenceIssue });
      } catch (levelError) {
        console.error('User license updated but level certification date failed:', levelError);
        return res.status(500).json({
          success: false,
          error: 'User license was updated, but the level certification date could not be saved.'
        });
      }
    });
});
// Admin login route
// Checks the `admins` table first (Admin-level / Super Admin roles created via
// adminManagement.html). Falls back to the legacy `users` table Manager
// check so existing Manager logins keep working exactly as before.
// On success, sets req.session.admin - the session key the admin dashboard
// page guard (requireAdminSession, defined near the static middleware above)
// requires. This route only affects admin-side login; it does not touch
// /employeelogin or any employee/course-attempting session logic.
app.post('/adminlogin', (req, res) => {
  const { username, password } = req.body;

  // Accounts created via adminManagement.html live in the `admins` table
  // (uRole 'Admin', 'P.V./T.L.', or 'Super Admin'). Check there first so those accounts
  // can actually log in. This is purely a credential check - no page
  // access gating is attached to it.
  connection.query('SELECT * FROM admins WHERE uName = ? AND uPass = ?', [username, password], (adminError, adminResults) => {
    if (adminError) {
      console.error('Error in admin login query:', adminError);
      return res.status(500).json({ success: false, message: 'Internal Server Error' });
    }

    if (adminResults.length > 0) {
      const admin = adminResults[0];
      req.session.user = { username: admin.uName, uniqueID: admin.uniqueID, uRole: admin.uRole, accountType: 'admin' };
      return res.json({ success: true, userRole: admin.uRole });
    }

    // Not in the admins table - fall back to the original users-table Manager login.
    connection.query('SELECT * FROM users WHERE uName = ? AND uPass = ?', [username, password], (error, results) => {
      if (error) {
        console.error('Error in database query:', error);
        return res.status(500).json({ success: false, message: 'Internal Server Error' });
      }
      if (results.length > 0) {
        // User found
        const userRole = results[0].uRole;
        if (userRole === 'Manager') {
          const user = results[0];
          req.session.user = { username: user.uName, uniqueID: user.uniqueID, uRole: user.uRole, accountType: 'user' };
          const currentDate = new Date();

          // Update lastLoggedIn column
          connection.query('UPDATE users SET lastLoggedIn = ? WHERE uName = ?', [currentDate, username], (updateError) => {
            if (updateError) {
              console.error('Error updating lastLoggedIn:', updateError);
              return res.status(500).json({ success: false, message: 'Failed to update login time' });
            }
            console.log('Login time updated successfully');
            return res.json({ success: true, userRole });
          });
        } else {
          return res.status(403).json({ success: false, message: 'You are not authorized to access this page.' });
        }
      } else {
        console.error('Invalid username or password');
        return res.status(401).json({ success: false, message: 'Invalid username or password' });
      }
    });
  });
});





// Route for serving userManagement.html
app.get('/userManagement', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'userManagement.html'));
});

// // Route for retrieving user data from the database
// app.get('/userData', (req, res) => {
//   // Query to retrieve user data from the database
//   const query = 'SELECT name, emailID, employeeID, uName, uPass, mobileNo, dateOfBirth, address, photo, dateOfJoining, mCourseName, uRole, currentDate,Contract FROM users'; // Adjust query based on your database schema
//   connection.query(query, (error, results) => {
//     if (error) {
//       console.error('Error retrieving user data:', error);
//       return res.status(500).send('Internal Server Error');
//     }
//     // Sending user data as JSON response
//     res.json(results);
//   });
// });


// test route
app.get('/userData', (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 50;
  const offset = (page - 1) * limit;

  const usersQuery = `
    SELECT
      uniqueID,
      name,
      emailID,
      employeeID,
      uName,
      uPass,
      mobileNo,
      dateOfBirth,
      address,
      photo,
      dateOfJoining,
      department,
      uRole,
      registerDate,
      registerTime,
      contract,
      qualification,
      userTags,
      isPreviousUser,
      previousCourseIDs
    FROM users
    ORDER BY uniqueID DESC
    LIMIT ?, ?
  `;

  const countQuery = `SELECT COUNT(*) as total FROM users`;

  // Run first query
  connection.query(usersQuery, [offset, limit], (err, usersResult) => {
    if (err) {
      console.error('Error fetching users:', err);
      return res.status(500).json({ error: 'Error fetching users' });  // ✅ Return valid JSON error
    }

    // Run second query
    connection.query(countQuery, (err2, countResult) => {
      if (err2) {
        console.error('Error fetching total:', err2);
        return res.status(500).json({ error: 'Error counting users' }); // ✅ Return valid JSON error
      }

      const total = countResult[0].total;
      return res.json({ users: usersResult, total });  // ✅ Return proper data
    });
  });
});







// NOTE: The old /gradesManagement route (and its backing /courseNames route
// below) queried a `courses` table that no longer exists - the schema was
// migrated to the subcourses/mcourses/comaincourses hierarchy, and this page
// was replaced by gradesReport.html (already unlinked from adminHomePage.html
// nav). Removed both dead routes so they stop throwing ER_NO_SUCH_TABLE.
// public/gradesManagement.html itself is left in place (static, now simply
// non-functional/unreachable via any live navigation) rather than deleted.


// Route for retrieving grades data from course tables
app.get('/gradesData', async (req, res) => {
  try {
    console.log('Starting gradesData fetch...');

    // Step 1: Get all courses with their IDs (using 'level' column name)
    const coursesQuery = 'SELECT courseID, courseName, level as courseLevel FROM courses ORDER BY courseID';

    connection.query(coursesQuery, async (error, courses) => {
      if (error) {
        console.error('Error retrieving courses:', error);
        return res.status(500).json({ error: 'Internal Server Error' });
      }

      console.log(`Found ${courses.length} courses`);

      if (courses.length === 0) {
        return res.json([]);
      }

      // Step 2: Get all users basic info
      const usersQuery = 'SELECT uniqueID, name, uName, employeeID, dateOfJoining, department, Contract FROM users';

      connection.query(usersQuery, async (userError, users) => {
        if (userError) {
          console.error('Error retrieving users:', userError);
          return res.status(500).json({ error: 'Internal Server Error' });
        }

        console.log(`Found ${users.length} users`);

        // Step 3: Create user data map with basic info
        const userDataMap = {};

        users.forEach(user => {
          userDataMap[user.uniqueID] = {
            uniqueID: user.uniqueID,
            name: user.name,
            uName: user.uName,
            employeeID: user.employeeID,
            dateOfJoining: user.dateOfJoining,
            department: user.department,
            Contract: user.Contract
          };
        });

        // Step 4: Fetch latest posttest score from each course table
        const coursePromises = courses.map((course, index) => {
          return new Promise((resolve) => {
            const tableName = `course_${course.courseID}`;

            console.log(`Processing ${tableName}...`);

            // Check if table exists first
            const checkTableQuery = `SHOW TABLES LIKE '${tableName}'`;

            connection.query(checkTableQuery, (checkErr, tableExists) => {
              if (checkErr || !tableExists || tableExists.length === 0) {
                console.log(`Table ${tableName} does not exist`);
                resolve({ courseIndex: index + 1, data: [] });
                return;
              }

              // Get all posttest columns for this course
              const getColumnsQuery = `SHOW COLUMNS FROM ${tableName} LIKE 'course_${course.courseID}_Posttest%'`;

              connection.query(getColumnsQuery, (colErr, columns) => {
                if (colErr) {
                  console.error(`Error getting columns from ${tableName}:`, colErr);
                  resolve({ courseIndex: index + 1, data: [] });
                  return;
                }

                if (!columns || columns.length === 0) {
                  console.log(`No posttest columns found in ${tableName}`);
                  resolve({ courseIndex: index + 1, data: [] });
                  return;
                }

                // Build the COALESCE query dynamically
                const posttestColumns = columns
                  .map(col => col.Field)
                  .sort((a, b) => {
                    // Extract attempt number and sort in descending order
                    const matchA = a.match(/(\d+)$/);
                    const matchB = b.match(/(\d+)$/);

                    if (!matchA || !matchB) return 0;

                    const numA = parseInt(matchA[1]);
                    const numB = parseInt(matchB[1]);

                    return numB - numA; // Descending order (latest first)
                  })
                  .map(col => `NULLIF(TRIM(${col}), '')`)
                  .join(', ');

                if (!posttestColumns) {
                  console.log(`Could not build COALESCE for ${tableName}`);
                  resolve({ courseIndex: index + 1, data: [] });
                  return;
                }

                const courseQuery = `
                  SELECT 
                    uniqueID,
                    COALESCE(${posttestColumns}) as latestPosttest
                  FROM ${tableName}
                  WHERE uniqueID IS NOT NULL
                `;

                console.log(`Querying ${tableName} with ${columns.length} posttest columns`);

                connection.query(courseQuery, (err, results) => {
                  if (err) {
                    console.error(`Error querying ${tableName}:`, err);
                    resolve({ courseIndex: index + 1, data: [] });
                  } else {
                    console.log(`${tableName}: Found ${results.length} records`);
                    resolve({ courseIndex: index + 1, data: results });
                  }
                });
              });
            });
          });
        });

        // Step 5: Wait for all course queries to complete
        console.log('Waiting for all course queries...');
        const courseResults = await Promise.all(coursePromises);
        console.log('All course queries completed');

        // Step 6: Merge course scores into user data
        courseResults.forEach(result => {
          const { courseIndex, data } = result;

          data.forEach(record => {
            if (userDataMap[record.uniqueID] && record.latestPosttest) {
              // Store the latest posttest score
              const score = parseFloat(record.latestPosttest);
              userDataMap[record.uniqueID][`course${courseIndex}Posttest`] = isNaN(score) ? record.latestPosttest : score;
            }
          });
        });

        // Step 7: Convert map to array and send response
        const finalData = Object.values(userDataMap);
        console.log(`Returning ${finalData.length} user records with scores from ${courses.length} courses`);

        res.json(finalData);
      });
    });

  } catch (error) {
    console.error('Error in gradesData route:', error);
    console.error('Stack trace:', error.stack);
    res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
});

// Add this endpoint to your backend (app.js or server.js)
// This version updates the LATEST (most recent) posttest score column

app.post('/saveChanges', async (req, res) => {

  try {
    const { updatedData } = req.body;

    if (!updatedData || updatedData.length === 0) {
      return res.status(400).json({ success: false, message: 'No data to update' });
    }

    console.log('Received updated data:', updatedData);

    // Process each update
    const updatePromises = updatedData.map(async (update) => {
      const { uniqueID, columnName, newValue, courseID, courseName } = update;

      if (!uniqueID || !courseID || !newValue) {
        console.warn('Skipping invalid update:', update);
        return { success: false, message: 'Missing required fields' };
      }

      const tableName = `course_${courseID}`;

      return new Promise((resolve) => {
        // Step 1: Check if table exists
        const checkTableQuery = `SHOW TABLES LIKE '${tableName}'`;

        connection.query(checkTableQuery, (checkErr, tableExists) => {
          if (checkErr || !tableExists || tableExists.length === 0) {
            console.error(`Table ${tableName} does not exist`);
            resolve({ success: false, message: `Table ${tableName} not found` });
            return;
          }

          // Step 2: Get all posttest columns to find the latest filled one
          const getColumnsQuery = `SHOW COLUMNS FROM ${tableName} LIKE 'course_${courseID}_Posttest%'`;

          connection.query(getColumnsQuery, (colErr, columns) => {
            if (colErr) {
              console.error(`Error getting columns from ${tableName}:`, colErr);
              resolve({ success: false, message: 'Error getting columns' });
              return;
            }

            if (!columns || columns.length === 0) {
              console.error(`No posttest columns found in ${tableName}`);
              resolve({ success: false, message: 'No posttest columns found' });
              return;
            }

            // Sort columns in DESCENDING order to get latest first
            const posttestColumns = columns
              .map(col => col.Field)
              .filter(field => field.match(/course_\d+_Posttest\d+$/))
              .sort((a, b) => {
                const matchA = a.match(/(\d+)$/);
                const matchB = b.match(/(\d+)$/);
                if (!matchA || !matchB) return 0;
                return parseInt(matchB[1]) - parseInt(matchA[1]); // Descending order
              });

            console.log(`Available columns for ${tableName}:`, posttestColumns);

            // Step 3: Find which column has the latest score for this user
            const checkLatestQuery = `
              SELECT ${posttestColumns.join(', ')}
              FROM ${tableName}
              WHERE uniqueID = ?
            `;

            connection.query(checkLatestQuery, [uniqueID], (checkErr, checkResult) => {
              if (checkErr) {
                console.error(`Error checking columns:`, checkErr);
                resolve({ success: false, message: 'Error checking columns' });
                return;
              }

              if (!checkResult || checkResult.length === 0) {
                console.error(`User ${uniqueID} not found in ${tableName}`);
                resolve({ success: false, message: 'User not found in course table' });
                return;
              }

              // Step 4: Find the LATEST filled posttest column (checking from newest to oldest)
              let targetColumn = null;
              const userData = checkResult[0];

              for (const col of posttestColumns) {
                const value = userData[col];
                if (value !== null && value !== '' && value !== undefined) {
                  targetColumn = col;
                  break; // Found the latest filled column
                }
              }

              if (!targetColumn) {
                console.error(`No posttest score found for user ${uniqueID} in ${tableName}`);
                resolve({ success: false, message: 'No existing score found to update' });
                return;
              }

              console.log(`Target column for update: ${targetColumn} (current value: ${userData[targetColumn]})`);

              // Derive related column names
              const match = targetColumn.match(/Posttest(\d+)$/);

if (!match) {
  console.error('Invalid Posttest column format:', targetColumn);
  resolve({ success: false, message: 'Invalid Posttest column format' });
  return;
}

const index = match[1];

// Build correct column names as per DB
const scoreColumn = `Score${index}`;
const statusColumn = `Status${index}`;

              // Determine status based on score
              const score = parseFloat(newValue);
              let status = 'Not Attempted';
              if (!isNaN(score)) {
                if (score >= 86) {
                  status = 'Pass';
                } else if (score >= 0) {
                  status = 'Fail';
                }
              }

              // Step 5: Update the latest posttest score
              const updateQuery = `
                UPDATE ${tableName}
                SET 
                  ${targetColumn} = ?,
                  ${scoreColumn} = ?,
                  ${statusColumn} = ?
                WHERE uniqueID = ?
              `;

              const updateValues = [newValue, score, status, uniqueID];

              console.log(`Executing update query:`, updateQuery);
              console.log(`Values:`, updateValues);

              connection.query(updateQuery, updateValues, (updateErr, updateResult) => {
                if (updateErr) {
                  console.error(`Error updating ${tableName}:`, updateErr);
                  resolve({
                    success: false,
                    message: `Error updating ${tableName}`,
                    error: updateErr.message
                  });
                  return;
                }

                console.log(`✓ Successfully updated ${tableName} for user ${uniqueID}`);
                console.log(`  Changed ${targetColumn}: ${userData[targetColumn]} → ${newValue}`);
                console.log(`  Status: ${status}`);

                resolve({
                  success: true,
                  message: `Updated ${courseName} score to ${newValue}`,
                  table: tableName,
                  column: targetColumn,
                  uniqueID: uniqueID,
                  oldValue: userData[targetColumn],
                  newValue: newValue
                });
              });
            });
          });
        });
      });
    });

    // Wait for all updates to complete
    const results = await Promise.all(updatePromises);

    // Check if any updates failed
    const failures = results.filter(r => !r.success);
    const successes = results.filter(r => r.success);

    console.log(`\n=== Update Summary ===`);
    console.log(`✓ Succeeded: ${successes.length}`);
    console.log(`✗ Failed: ${failures.length}`);

    if (successes.length > 0) {
      console.log('\nSuccessful updates:');
      successes.forEach(s => {
        console.log(`  - ${s.message} (${s.oldValue} → ${s.newValue})`);
      });
    }

    if (failures.length > 0) {
      console.error('\nFailed updates:');
      failures.forEach(f => {
        console.error(`  - ${f.message}`);
      });
    }

    res.json({
      success: true,
      message: `${successes.length} updates completed successfully${failures.length > 0 ? `, ${failures.length} failed` : ''}`,
      results: results,
      successCount: successes.length,
      failureCount: failures.length
    });

  } catch (error) {
    console.error('Error in saveChanges route:', error);
    console.error('Stack trace:', error.stack);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      details: error.message
    });
  }
});


//Get data from Database of specific ID
app.get("/getCertificate", (req, res) => {
  const id = req.query.id;
  // Optional - only present for Level 2/3/4 certificates (see
  // levelCertificate.html). When given, we additionally look up every
  // subcourse under this Level (own Line + any Common courses for that
  // Level) and this user's latest score for each, so the certificate page
  // can print a third barcode encoding "<subCourseID>_<mark>" pairs - e.g.
  // "12_80_13_90_14_90" - one pair per course. Level 1 certificates never
  // send `level`/`mCourseID`, so they get exactly the same response as
  // before (untouched).
  const level = req.query.level;
  const mCourseID = req.query.mCourseID;
  console.log("ID" + id);
  if (!id) {
    return res.json({ error: "No ID provided" });
  }

  const query = "SELECT * FROM users  WHERE uniqueID = ?";
  connection.query(query, [id], (err, result) => {
    if (err) {
      console.log(res);
      return res.json({ error: "Database error" });

    }
    if (result.length === 0) {
      console.log(res);
      return res.json({ error: "No record found" });
    }
    const user = result[0];

    // Assigned Department/Segment(Area)/Line/Station, if any (see
    // /api/enrollstatus/assignProcess + /api/enrollstatus/assignStation on
    // the Enrollment page). Attached to every certificate response so the
    // Level 1 certificate barcode can carry this to the correct Segment PC
    // (Stage 2 of the multi-PC deployment) - stationID 0/absent means
    // "whole line, no specific station yet".
    const assignmentQuery = `
      SELECT es.deptID, es.areaID, es.mCourseID, es.stationID,
             d.deptName, a.areaName, mc.mCourseName, st.stationName
      FROM enrollstatus es
      LEFT JOIN departments d ON d.deptID = es.deptID
      LEFT JOIN areas a ON a.areaID = es.areaID
      LEFT JOIN mcourses mc ON mc.mCourseID = es.mCourseID
      LEFT JOIN stations st ON st.stationID = es.stationID AND es.stationID <> 0
      WHERE es.uniqueID = ? AND es.coMCourseID IS NULL AND es.subCourseID IS NULL
        AND COALESCE(es.enrollStatus, 'Active') IN ('Active', 'active', 'Enrolled', 'enrolled')
      ORDER BY es.enrollID DESC
      LIMIT 1
    `;

    const levelNum = Number(level);

    connection.query(assignmentQuery, [id], (aErr, aRows) => {
      const assignment = (!aErr && aRows && aRows.length) ? {
        deptID: aRows[0].deptID, deptName: aRows[0].deptName,
        areaID: aRows[0].areaID, areaName: aRows[0].areaName,
        mCourseID: aRows[0].mCourseID, mCourseName: aRows[0].mCourseName,
        stationID: aRows[0].stationID || 0, stationName: aRows[0].stationName || null
      } : null;
      if (aErr) console.error('Error loading assignment for certificate:', aErr);

    if (!levelNum || levelNum < 2 || levelNum > 4) {
      console.log(res);
      return res.json({ ...user, assignment });
    }

    const levelLabel = `Level ${levelNum}`;
    const levelMatchValues = levelNum === 2 ? [levelLabel, 'default'] : [levelLabel];
    const levelMatchClause = levelNum === 2
      ? '(sc.subCourseLevel IS NULL OR sc.subCourseLevel IN (?))'
      : 'sc.subCourseLevel IN (?)';
    // Common Level 2/3/4 courses (sc.mCourseID IS NULL) count for every Line,
    // same visibility rule as /getViewscormCourseList.
    const hierarchyClause = mCourseID ? '(sc.mCourseID = ? OR sc.mCourseID IS NULL)' : 'sc.mCourseID IS NULL';
    const hierarchyParams = mCourseID ? [mCourseID] : [];

    const marksQuery = `
      SELECT sc.subCourseID, sc.courseType,
        CASE
          WHEN sc.courseType IN ('assessment','scorm') THEN (SELECT cg.score FROM coursegrades cg WHERE cg.uniqueID = ? AND cg.subCourseID = sc.subCourseID ORDER BY cg.id DESC LIMIT 1)
          WHEN sc.courseType = 'practical' THEN (SELECT pe.finalPercent FROM practicalevaluations pe WHERE pe.uniqueID = ? AND pe.subCourseID = sc.subCourseID AND pe.evaluationStatus = 'Submitted' LIMIT 1)
          ELSE (SELECT tg.score FROM traininggrades tg WHERE tg.uniqueID = ? AND tg.subCourseID = sc.subCourseID ORDER BY tg.id DESC LIMIT 1)
        END AS score,
        CASE
          WHEN sc.courseType IN ('assessment','scorm') THEN (SELECT cg.status FROM coursegrades cg WHERE cg.uniqueID = ? AND cg.subCourseID = sc.subCourseID ORDER BY cg.id DESC LIMIT 1)
          WHEN sc.courseType = 'practical' THEN (SELECT pe.finalResult FROM practicalevaluations pe WHERE pe.uniqueID = ? AND pe.subCourseID = sc.subCourseID AND pe.evaluationStatus = 'Submitted' LIMIT 1)
          ELSE (SELECT tg.status FROM traininggrades tg WHERE tg.uniqueID = ? AND tg.subCourseID = sc.subCourseID ORDER BY tg.id DESC LIMIT 1)
        END AS status
      FROM subcourses sc
      WHERE sc.courseType IN ('assessment','training','scorm','practical') AND ${levelMatchClause} AND ${hierarchyClause}
      ORDER BY sc.subCourseID
    `;
    connection.query(
      marksQuery,
      [id, id, id, id, id, id, levelMatchValues, ...hierarchyParams],
      (mErr, rows) => {
        if (mErr) {
          console.error('Error loading level course marks for certificate barcode:', mErr);
          return res.json({ ...user, assignment }); // degrade gracefully - certificate still prints, just without the courses barcode
        }
        const levelCourseMarks = rows
          .map(r => {
            const mark = r.score != null ? Math.round(Number(r.score)) : (r.status === 'Completed' ? 100 : 0);
            return `${r.subCourseID}_${mark}`;
          })
          .join('_');
        res.json({ ...user, levelCourseMarks, assignment });
      }
    );
    });
  });
});


// Generates a QR code PNG (as a data URL) for the level certificate's
// "Print QR Code" button. Runs fully offline via the local `qrcode` package
// - no CDN, no network call at request time. Admin-only, read-only.
app.get('/api/admin/qrcode', async (req, res) => {
  const text = req.query.text;
  if (!text) {
    return res.status(400).json({ success: false, error: 'text is required' });
  }
  try {
    const dataUrl = await QRCode.toDataURL(String(text), { width: 320, margin: 1 });
    res.json({ success: true, dataUrl });
  } catch (error) {
    console.error('Error generating QR code:', error);
    res.status(500).json({ success: false, error: 'Failed to generate QR code' });
  }
});

// Add this endpoint to your server file (e.g., server.js or app.js)

app.get('/getUsersBymCourseName', (req, res) => {
  const { mCourseName } = req.query;

  if (!mCourseName || mCourseName === 'all') {
    return res.json({ success: true, userIDs: [], mCourseName: 'all', courseCount: 0 });
  }

  // Step 1: Get all courses for the selected department
  const coursesQuery = 'SELECT courseID FROM courses WHERE mCourseName = ?';

  connection.query(coursesQuery, [mCourseName], (error, courses) => {
    if (error) {
      console.error('Error fetching courses:', error);
      return res.status(500).json({
        success: false,
        message: 'Error fetching courses',
        error: error.message
      });
    }

    if (courses.length === 0) {
      return res.json({
        success: true,
        userIDs: [],
        mCourseName: mCourseName,
        courseCount: 0
      });
    }

    // Step 2: Collect all unique user IDs
    const userIDsSet = new Set();
    let processedCount = 0;

    courses.forEach((course, index) => {
      const tableName = `course_${course.courseID} `;
      const usersQuery = `SELECT DISTINCT uniqueID FROM ${tableName} WHERE uniqueID IS NOT NULL`;

      connection.query(usersQuery, (err, users) => {
        if (!err && users) {
          users.forEach(user => {
            if (user.uniqueID) {
              userIDsSet.add(user.uniqueID);
            }
          });
        }

        processedCount++;

        // When all courses are processed, send response
        if (processedCount === courses.length) {
          const userIDs = Array.from(userIDsSet);
          res.json({
            success: true,
            userIDs: userIDs,
            department: courses.department,
            courseCount: courses.length
          });
        }
      });
    });
  });
});




// Route to fetch user grades based on employeeID old 26-07-2025
/*app.get('/getUserGrades', (req, res) => {
  const employeeID = req.query.employeeID;
  const query = 'SELECT * FROM users WHERE employeeID = ?';
  connection.query(query, [employeeID], (error, results) => {
    if (error) {
      console.error('Error fetching user data:', error);
      return res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
    if (results.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Extract user details from the query results
    const userDetails = {
      // name: results[0].name,
      // uName: results[0].uName
      employeeID: results[0].employeeID, // Assuming this is the field name in your database
      name: results[0].name
      // Add more user details if needed
    };

    // Extract grades from the query results
    const grades = [];
    // Assuming uCourse1, uCourse2, ... are columns in the users table
    for (let i = 1; i <= 50; i++) {
      const courseName = results[0][`uCourse${ i } `] || 'N/A';
      const posttest = results[0][`course${ i } Posttest`] || 'N/A';
      grades.push({ courseName, posttest });
    }

    res.json({ userDetails, grades });
  });
});*/


// Route to fetch user grades based on employeeID new 26-07-2025

// Route to fetch user grades **from course_${courseID} tables** based on uniqueID
app.get('/getUserGrades', (req, res) => {
  const uniqueID = req.query.uniqueID;

  if (!uniqueID) {
    return res
      .status(400)
      .json({ error: 'uniqueID is required to fetch user grades.' });
  }

  // 1) Get basic user details from users table
  const userQuery = `
    SELECT uniqueID, employeeID, name, uName
    FROM users
    WHERE uniqueID = ?
  `;

  connection.query(userQuery, [uniqueID], (userError, userResults) => {
    if (userError) {
      console.error('Error fetching user details:', userError);
      return res.status(500).json({ error: 'Internal Server Error' });
    }

    if (userResults.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userDetails = userResults[0];

    // 2) Get list of all courses (we’ll look into each course_X table)
    const coursesQuery = `
      SELECT courseID, courseName
      FROM courses
      ORDER BY courseID
    `;

    connection.query(coursesQuery, (coursesError, coursesResults) => {
      if (coursesError) {
        console.error('Error fetching courses:', coursesError);
        return res.status(500).json({ error: 'Internal Server Error' });
      }

      if (!coursesResults.length) {
        // No courses; return only user details
        return res.json({ userDetails, grades: [] });
      }

      const MAX_ATTEMPTS = 27; // matches the table structure you create in /upload :contentReference[oaicite:1]{index=1}

      const coursePromises = coursesResults.map((course) => {
        return new Promise((resolve) => {
          const courseID = course.courseID;
          const tableName = `course_${courseID}`;

          // 2a) Check if this course table exists
          const checkTableQuery = `SHOW TABLES LIKE ?`;
          connection.query(checkTableQuery, [tableName], (checkErr, checkRes) => {
            if (checkErr) {
              console.error(`Error checking table ${tableName}:`, checkErr);
              return resolve(null);
            }
            if (!checkRes.length) {
              // Table does not exist – skip this course
              return resolve(null);
            }

            // 2b) Get the row for this user in that course table
            const rowQuery = `SELECT * FROM ${tableName} WHERE uniqueID = ? LIMIT 1`;
            connection.query(rowQuery, [uniqueID], (rowErr, rowResults) => {
              if (rowErr) {
                console.error(
                  `Error fetching user row from ${tableName}:`,
                  rowErr
                );
                return resolve(null);
              }
              if (!rowResults.length) {
                // User not enrolled / no attempts in this course
                return resolve(null);
              }

              const row = rowResults[0];

              // 2c) Find the latest attempt that actually has data
              let latestAttempt = null;
              for (let attempt = MAX_ATTEMPTS; attempt >= 1; attempt--) {
                const posttestKey = `course_${courseID}_Posttest${attempt}`;
                if (
                  Object.prototype.hasOwnProperty.call(row, posttestKey) &&
                  row[posttestKey] != null &&
                  row[posttestKey] !== ''
                ) {
                  const scoreKey = `score${attempt}`;
                  const dateKey = `date${attempt}`;

                  latestAttempt = {
                    attemptNumber: attempt,
                    // Prefer numeric score column if available, otherwise use the posttest column
                    posttest:
                      row[scoreKey] != null && row[scoreKey] !== ''
                        ? row[scoreKey]
                        : row[posttestKey],
                    attendanceDate: row[dateKey] || null,
                  };
                  break;
                }
              }

              if (!latestAttempt) {
                // User has a row but no actual attempts filled
                return resolve(null);
              }

              // Shape matches what userGradesReport.html expects
              const gradeEntry = {
                courseID: courseID,
                courseName: course.courseName,
                posttest: latestAttempt.posttest,
                attendanceDate: latestAttempt.attendanceDate,
              };

              resolve(gradeEntry);
            });
          });
        });
      });

      Promise.all(coursePromises)
        .then((results) => {
          // Filter out nulls (courses with no attempts / tables missing)
          const grades = results.filter((g) => g && g.posttest != null);

          return res.json({
            userDetails,
            grades,
          });
        })
        .catch((err) => {
          console.error('Error aggregating course grades:', err);
          res.status(500).json({ error: 'Internal Server Error' });
        });
    });
  });
});


// ============================================
// REFRESHAL TRAINING GRADES MANAGEMENT ROUTES
// ============================================

// Get all main course names for refreshal training
app.get('/refreshalTrainMCourseNames', (req, res) => {
  const query = 'SELECT id, mCourseName FROM department';

  connection.query(query, (error, results) => {
    if (error) {
      console.error('Error fetching main course names:', error);
      res.status(500).json({ error: 'Internal server error' });
      return;
    }

    const mCourseName = results.map(row => ({
      id: row.id,
      name: row.mCourseName
    }));

    res.json({ mCourseName });
  });
});

// Get refreshal training course names
app.get('/refreshalTrainCourseNames', (req, res) => {
  const query = `
  SELECT DISTINCT originalCourseID,
         (SELECT courseName FROM courses WHERE courseID = refreshaltrain.originalCourseID) as courseName
  FROM refreshaltrain
  WHERE originalCourseID IS NOT NULL
  ORDER BY originalCourseID
`;

  connection.query(query, (error, results) => {
    if (error) {
      console.error('Error fetching refreshal course names:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }

    const courses = results.map(row => ({
      courseID: row.originalCourseID,
      courseName: row.courseName || `Course ${row.originalCourseID}`
    }));

    res.json(courses);
  });
});

// Get users by main course name for refreshal training
app.get('/refreshalTrainUsersByMCourseName', (req, res) => {
  const { mCourseName } = req.query;

  if (!mCourseName || mCourseName === 'all') {
    return res.json({ success: true, userIDs: [], mCourseName: 'all', courseCount: 0 });
  }

  // Get all original courseIDs for this main course
  const coursesQuery = 'SELECT courseID FROM courses WHERE mCourseName = ?';

  connection.query(coursesQuery, [mCourseName], (error, courses) => {
    if (error) {
      console.error('Error fetching courses:', error);
      return res.status(500).json({
        success: false,
        message: 'Error fetching courses',
        error: error.message
      });
    }

    if (courses.length === 0) {
      return res.json({
        success: true,
        userIDs: [],
        mCourseName: mCourseName,
        courseCount: 0
      });
    }

    const courseIDs = courses.map(c => c.courseID);
    const userIDsSet = new Set();
    let processedCount = 0;

    courseIDs.forEach((courseID) => {
      const usersQuery = `
        SELECT DISTINCT uniqueID 
        FROM refreshaltrain 
        WHERE originalCourseID = ? AND uniqueID IS NOT NULL
      `;

      connection.query(usersQuery, [courseID], (err, users) => {
        if (!err && users) {
          users.forEach(user => {
            if (user.uniqueID) {
              userIDsSet.add(user.uniqueID);
            }
          });
        }

        processedCount++;

        if (processedCount === courseIDs.length) {
          const userIDs = Array.from(userIDsSet);
          res.json({
            success: true,
            userIDs: userIDs,
            mCourseName: mCourseName,
            courseCount: courseIDs.length
          });
        }
      });
    });
  });
});

// Get refreshal training grades data
app.get('/refreshalTrainGradesData', async (req, res) => {
  try {
    console.log('Starting refreshalTrainGradesData fetch...');

    // Step 1: Get all unique original courseIDs from refreshaltrain
    // NEW — gets ALL courses + correct names from courses table
    // OLD — limits courses to only those already in refreshaltrain
const coursesQuery = `
  SELECT DISTINCT originalCourseID,
         (SELECT courseName FROM courses WHERE courseID = refreshaltrain.originalCourseID) as courseName
  FROM refreshaltrain
  WHERE originalCourseID IS NOT NULL
  ORDER BY originalCourseID
`;

    connection.query(coursesQuery, async (error, courses) => {
      if (error) {
        console.error('Error retrieving courses:', error);
        return res.status(500).json({ error: 'Internal Server Error' });
      }

      console.log(`Found ${courses.length} refreshal courses`);

      if (courses.length === 0) {
        return res.json([]);
      }

      // Step 2: Get all users basic info
      const usersQuery = 'SELECT uniqueID, name, employeeID FROM users';

      connection.query(usersQuery, async (userError, users) => {
        if (userError) {
          console.error('Error retrieving users:', userError);
          return res.status(500).json({ error: 'Internal Server Error' });
        }

        console.log(`Found ${users.length} users`);

        // Step 3: Create user data map
        const userDataMap = {};

        users.forEach(user => {
          userDataMap[user.uniqueID] = {
            uniqueID: user.uniqueID,
            name: user.name,
            employeeID: user.employeeID,
            courses: []
          };
        });

        // Step 4: Fetch scores for each course
        const coursePromises = courses.map((course) => {
          return new Promise((resolve) => {
            const courseID = course.originalCourseID;

            // Get all score columns (score1 to score4 as per your refreshaltrain table structure)
            const scoreQuery = `
              SELECT 
                uniqueID,
                COALESCE(
                  NULLIF(TRIM(score4), ''),
                  NULLIF(TRIM(score3), ''),
                  NULLIF(TRIM(score2), ''),
                  NULLIF(TRIM(score1), '')
                ) as latestScore
              FROM refreshaltrain
              WHERE originalCourseID = ? AND uniqueID IS NOT NULL
            `;

            connection.query(scoreQuery, [courseID], (err, results) => {
              if (err) {
                console.error(`Error querying refreshaltrain for course ${courseID}:`, err);
                resolve({ courseID: courseID, data: [] });
              } else {
                console.log(`Course ${courseID}: Found ${results.length} records`);
                resolve({ courseID: courseID, courseName: course.courseName, data: results });
              }
            });
          });
        });

        // Step 5: Wait for all course queries to complete
        console.log('Waiting for all course queries...');
        const courseResults = await Promise.all(coursePromises);
        console.log('All course queries completed');

        // Step 6: Merge course scores into user data
        courseResults.forEach(result => {
          const { courseID, courseName, data } = result;

          data.forEach(record => {
            if (userDataMap[record.uniqueID] && record.latestScore) {
              const score = parseFloat(record.latestScore);
              if (!isNaN(score)) {
                userDataMap[record.uniqueID].courses.push({
                  courseID: courseID,
                  courseName: courseName || `Course ${courseID}`,
                  bestScore: score
                });
              }
            }
          });
        });

        // Step 7: Convert map to array and send response
        const finalData = Object.values(userDataMap);
        console.log(`Returning ${finalData.length} user records`);

        res.json(finalData);
      });
    });

  } catch (error) {
    console.error('Error in refreshalTrainGradesData route:', error);
    console.error('Stack trace:', error.stack);
    res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
});

// Save changes for refreshal training grades
app.post('/saveRefreshalTrainChanges', async (req, res) => {
  try {
    const { updatedData } = req.body;

    if (!updatedData || updatedData.length === 0) {
      return res.status(400).json({ success: false, message: 'No data to update' });
    }

    console.log('Received updated data:', updatedData);

    const updatePromises = updatedData.map(async (update) => {
      const { uniqueID, courseID, newValue, attemptNumber } = update;

      if (!uniqueID || !courseID || !newValue) {
        console.warn('Skipping invalid update:', update);
        return { success: false, message: 'Missing required fields' };
      }

      return new Promise((resolve) => {
        // Find the refreshaltrain record
        const findQuery = `
          SELECT id 
          FROM refreshaltrain 
          WHERE originalCourseID = ? AND uniqueID = ?
          ORDER BY id DESC 
          LIMIT 1
        `;

        connection.query(findQuery, [courseID, uniqueID], (findErr, results) => {
          if (findErr || !results || results.length === 0) {
            console.error(`Refreshal training record not found for course ${courseID}, user ${uniqueID}`);
            resolve({ success: false, message: 'Record not found' });
            return;
          }

          const recordId = results[0].id;
          const attempt = attemptNumber || 1; // Default to attempt 1 if not specified

          // Determine status based on score
          const score = parseFloat(newValue);
          let status = 'Not Attempted';
          if (!isNaN(score)) {
            if (score >= 86) {
              status = 'Pass';
            } else if (score >= 0) {
              status = 'Fail';
            }
          }

          // Update the score
          const updateQuery = `
            UPDATE refreshaltrain
            SET 
              score${attempt} = ?,
              status${attempt} = ?,
              date${attempt} = NOW()
            WHERE id = ?
          `;

          const updateValues = [score, status, recordId];

          console.log(`Updating refreshaltrain record ${recordId}, attempt ${attempt}`);

          connection.query(updateQuery, updateValues, (updateErr, updateResult) => {
            if (updateErr) {
              console.error(`Error updating refreshaltrain:`, updateErr);
              resolve({
                success: false,
                message: 'Error updating record',
                error: updateErr.message
              });
              return;
            }

            console.log(`✓ Successfully updated refreshaltrain for user ${uniqueID}, course ${courseID}`);

            resolve({
              success: true,
              message: `Updated refreshal training score to ${newValue}`,
              recordId: recordId,
              uniqueID: uniqueID,
              courseID: courseID,
              newValue: newValue
            });
          });
        });
      });
    });

    // Wait for all updates to complete
    const results = await Promise.all(updatePromises);

    // Check if any updates failed
    const failures = results.filter(r => !r.success);
    const successes = results.filter(r => r.success);

    console.log(`\n=== Update Summary ===`);
    console.log(`✓ Succeeded: ${successes.length}`);
    console.log(`✗ Failed: ${failures.length}`);

    if (successes.length > 0) {
      console.log('\nSuccessful updates:');
      successes.forEach(s => {
        console.log(`  - ${s.message}`);
      });
    }

    if (failures.length > 0) {
      console.error('\nFailed updates:');
      failures.forEach(f => {
        console.error(`  - ${f.message}`);
      });
    }

    res.json({
      success: true,
      message: `${successes.length} updates completed successfully${failures.length > 0 ? `, ${failures.length} failed` : ''}`,
      results: results,
      successCount: successes.length,
      failureCount: failures.length
    });

  } catch (error) {
    console.error('Error in saveRefreshalTrainChanges route:', error);
    console.error('Stack trace:', error.stack);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      details: error.message
    });
  }
});




// Route to fetch user grades and attempts data based on employeeID
/*app.get('/getUserGrades', (req, res) => {
  const employeeID = req.query.employeeID;

  // Query to get user details from the users table
  const userQuery = 'SELECT * FROM users WHERE employeeID = ?';
  connection.query(userQuery, [employeeID], (userError, userResults) => {
    if (userError) {
      console.error('Error fetching user data:', userError);
      return res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
    if (userResults.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Extract user details
    const userDetails = {
      employeeID: userResults[0].employeeID,
      name: userResults[0].name,
    };

    // Extract grades from the user results
    const grades = [];
    for (let i = 1; i <= 15; i++) {
      const courseName = userResults[0][`uCourse${ i } `] || 'N/A';
      const posttest = userResults[0][`course${ i } Posttest`] || 'N/A';
    }

    // Query to get attempts data from course_${courseID} table
    const attemptsQuery = `SELECT * FROM course_${ courseID } WHERE employeeID = ? `;
    connection.query(attemptsQuery, [employeeID], (attemptsError, attemptsResults) => {
      if (attemptsError) {
        console.error('Error fetching attempts data:', attemptsError);
        return res.status(500).json({ success: false, message: 'Internal Server Error' });
      }

      // Prepare the response with user details, grades, and attempts
      res.json({ userDetails, grades, attempts: attemptsResults });
    });
  });
});*/


// Route to fetch user attempt data based on courseID and attemptNumber
// app.get('/getUserAttempts', (req, res) => {
//   const courseID = req.query.courseID;
//   const attemptNumber = req.query.attemptNumber;
//   const employeeID = req.query.employeeID; // Pass this from the front-end if needed
//   if (!courseID || !attemptNumber) {
//     return res.status(400).json({ success: false, message: 'Course ID and attempt number are required.' });
//   }

//   /*const query = `SELECT noOfAttempts,
//                         course_${courseID}_Posttest${attemptNumber} AS posttest, 
//                         score${attemptNumber} AS score, 
//                         status${attemptNumber} AS status, 
//                         duration${attemptNumber} AS duration 
//                  FROM course_${courseID} 
//                  WHERE employeeID = ?`;*/
//   /*const query = `
//   SELECT 
//       noOfAttempts, course_${courseID}_Posttest${attemptNumber},
//       score${attemptNumber}, status${attemptNumber}, duration${attemptNumber}
//   FROM course_${courseID}
//   WHERE employeeID = ?
// `;*/
//   const query = `
//   SELECT 
//       noOfAttempts,  
//       course_${courseID}_Posttest${attemptNumber} AS posttest,
//       score${attemptNumber} AS score, 
//       status${attemptNumber} AS status, 
//       duration${attemptNumber} AS duration,
//       date${attemptNumber} AS date
//   FROM course_${courseID}
//   WHERE employeeID = ?
// `;


//   connection.query(query, [employeeID], (error, results) => {
//     if (error) {
//       console.error('Error fetching attempt data:', error);
//       console.error('courseID fail: ', courseID);
//       console.error('attemptNumber fail: ', attemptNumber);
//       console.error('employeeID fail: ', employeeID);
//       return res.status(500).json({ success: false, message: 'Internal Server Error' });
//     }
//     if (results.length === 0) {
//       console.error('courseID fail 2: ', courseID);
//       console.error('attemptNumber fail 2: ', attemptNumber);
//       console.error('employeeID fail 2: ', employeeID);
//       return res.status(404).json({ success: false, message: 'No data found for this attempt.' });
//     }
//     console.error('courseID Pass 2: ', courseID);
//     console.error('attemptNumber Pass 2: ', attemptNumber);
//     console.error('results Pass 2: ', results);

//     const attemptDetails_noOfAttempt = results[0].noOfAttempts;
//     const attemptDetails_posttest = results[0].posttest;
//     const attemptDetails_score = results[0].score;
//     const attemptDetails_status = results[0].status;
//     const attemptDetails_duration = results[0].duration;
//     const attemptsDetails_date=results[0].date;

//     console.error('results Pass 3: ', results[0].noOfAttempts);

//     res.json({ success: true, attemptData: results[0], attemptDetails_noOfAttempt: attemptDetails_noOfAttempt, attemptDetails_posttest: attemptDetails_posttest, attemptDetails_score: attemptDetails_score, attemptDetails_status: attemptDetails_status, attemptDetails_duration: attemptDetails_duration ,attemptsDetails_date: attemptsDetails_date});
//   });
// });





app.get('/getUserAttempts', (req, res) => {
  const { courseID, attemptNumber, uniqueID } = req.query; // Destructure for cleaner access

  // Basic validation for required parameters
  if (!courseID || !attemptNumber || !uniqueID) {
    return res.status(400).json({
      success: false,
      message: 'Course ID, attempt number, and uniqueID are required.'
    });
  }

  // Construct the table name and column names dynamically
  const tableName = `course_${courseID}`;
  const posttestCol = `course_${courseID}_Posttest${attemptNumber}`;
  const scoreCol = `score${attemptNumber}`;
  const statusCol = `status${attemptNumber}`;
  const durationCol = `duration${attemptNumber}`;
  const dateCol = `date${attemptNumber}`;

  // Construct the SQL query using backticks for template literals
  // This helps in dynamic column naming
  const query = `
    SELECT
      noOfAttempts,
      ${posttestCol} AS posttest,
      ${scoreCol} AS score,
      ${statusCol} AS status,
      ${durationCol} AS duration,
      ${dateCol} AS date
    FROM ${tableName}
    WHERE uniqueID = ?;
  `;

  connection.query(query, [uniqueID], (error, results) => {
    if (error) {
      console.error('Database query error:', error);
      // Log specific details for debugging
      console.error(`Query: ${query}`);
      console.error(`Parameters: [${uniqueID}]`);
      console.error(`Error details: courseID=${courseID}, attemptNumber=${attemptNumber}, uniqueID=${uniqueID}`);

      // Check for common SQL errors
      if (error.code === 'ER_NO_SUCH_TABLE') {
        return res.status(500).json({
          success: false,
          message: `Error: Table '${tableName}' does not exist. Please check your database schema.`,
          errorCode: error.code
        });
      } else if (error.code === 'ER_BAD_FIELD_ERROR') {
        return res.status(500).json({
          success: false,
          message: `Error: One or more columns (e.g., ${posttestCol}, ${scoreCol}, ${statusCol}, ${durationCol}, ${dateCol}) do not exist in table '${tableName}'. Please check your database schema.`,
          errorCode: error.code
        });
      }
      return res.status(500).json({ success: false, message: 'Internal Server Error during database query.' });
    }

    if (results.length === 0) {
      // This is the case you are hitting: no rows found for the given uniqueID in the specified table.
      console.warn(`No data found for uniqueID: ${uniqueID} in table: ${tableName} for attempt: ${attemptNumber}`);
      return res.status(404).json({
        success: false,
        message: `No attempt data found for uniqueID ${uniqueID} in course ${courseID} for attempt number ${attemptNumber}.`
      });
    }

    // If data is found, send the first result directly.
    // The aliases in the SQL query (AS posttest, AS score, etc.) make the result object cleaner.
    const attemptData = results[0];

    console.log('Successfully fetched attempt data:', attemptData);

    res.json({
      success: true,
      attemptData: attemptData
    });
  });
});





/*
// Route to delete a user from the database
app.delete('/deleteUser', (req, res) => {
  const { employeeID } = req.body; // Assuming you are passing employeeID from the client-side
  // Perform deletion operation in the database based on employeeID
  const query = 'DELETE FROM users WHERE employeeID = ?';
  connection.query(query, [employeeID], (error, results) => {
    if (error) {
      console.error('Error deleting user:', error);
      return res.status(500).send('Internal Server Error');
    }
    console.log('User deleted successfully');
    res.sendStatus(200);
  });
});*/

//Function for delete users in user Management 23-07-25
app.delete('/deleteUser', (req, res) => {
  const uniqueID = req.body.uniqueID || req.query.uniqueID || req.params.uniqueID;
  if (!uniqueID) {
    return res.status(400).send('uniqueID is required');
  }
  // Perform deletion operation in the database based on uniqueID
  const query = 'DELETE FROM users WHERE uniqueID = ?';
  connection.query(query, [uniqueID], (error, results) => {
    if (error) {
      console.error('Error deleting user:', error);
      return res.status(500).send('Internal Server Error');
    }
    console.log('User deleted successfully');
    res.sendStatus(200);
  });
});







// Add a route for logging out
app.get('/logout', (req, res) => {
  // Clear the user's session
  req.session.destroy((err) => {
    if (err) {
      console.error('Error destroying session:', err);
      return res.status(500).send('Internal Server Error');
    }
    // Redirect the user to the login page after logout
    res.redirect('/home.html'); // Update the path to your login page
  });
});



// Update user's SCORM data old 34-07-2025
/*app.post('/updateUserSCORMData', (req, res) => {
 
  const trainDate = currentDate+currentTime;
  const { posttestScore, courseID, courseName } = req.body;
  const uniqueID = req.session.user.uniqueID;
 
  // // Use the currentCourseID global variable here
  // const query2 = `SELECT courseID FROM courses ORDER BY id DESC`;
  // Construct the column names dynamically based on the courseID
  const posttestColumn = `course${courseID}Posttest`;
  const courseNameColumn = `uCourse${courseID}`;
  const trainDateColumn = `course${courseID}TrainDate`;
 
  console.log("uniqueID is: " + uniqueID);
 
  // Update the user's SCORM data in the database
  const query = `UPDATE users SET ${posttestColumn} = ?, ${courseNameColumn} = ?, ${trainDateColumn} =? WHERE uniqueID = ?`;
  connection.query(query, [posttestScore, courseName, trainDate, uniqueID], (error, results) => {
    if (error) {
      console.error('Error updating user SCORM data:', error);
      console.log("uniqueID is in error: " + uniqueID);
      return res.status(500).send('Internal Server Error');
    }
    console.log('User SCORM data updated successfully');
    console.log('Result ', posttestScore, courseName,trainDate, uniqueID);
    res.sendStatus(200);
  });
});*/





/*app.post('/updateUserSCORMData', (req, res) => {
  const { posttestScore, courseID, courseName } = req.body;
  const uniqueID = req.session.user.uniqueID;
 
  // Format current date and time in 'YYYY-MM-DD HH:mm:ss' (local time)
  const now = new Date();
  const trainDate = now.toLocaleString('en-GB', {
    timeZone: 'Asia/Kolkata', // or your preferred time zone
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).replace(',', '');
 
  const posttestColumn = `course${courseID}Posttest`;
  const courseNameColumn = `uCourse${courseID}`;
  const trainDateColumn = `course${courseID}TrainDate`;
 
  const query = `UPDATE users SET ${posttestColumn} = ?, ${courseNameColumn} = ?, ${trainDateColumn} = ? WHERE uniqueID = ?`;
  connection.query(query, [posttestScore, courseName, trainDate, uniqueID], (error, results) => {
    if (error) {
      console.error('Error updating user SCORM data:', error);
      return res.status(500).send('Internal Server Error');
    }
    console.log('Updated with time:', trainDate);
    res.sendStatus(200);
  });
});*/





// At the top of your file (outside the route handler)
function getFormattedDateTimeIST() {
  const now = new Date();
  const istNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));

  const yyyy = istNow.getFullYear();
  const mm = String(istNow.getMonth() + 1).padStart(2, '0');
  const dd = String(istNow.getDate()).padStart(2, '0');
  const hh = String(istNow.getHours()).padStart(2, '0');
  const min = String(istNow.getMinutes()).padStart(2, '0');
  const ss = String(istNow.getSeconds()).padStart(2, '0');

  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
}


// Commented by yash on 27-09-2025 3.05pm
// app.post('/updateUserSCORMData', (req, res) => {
//   const { posttestScore, courseID, courseName } = req.body;

//   if (!req.session || !req.session.user || !req.session.user.uniqueID) {
//     return res.status(401).send('User session not found');
//   }

//   const uniqueID = req.session.user.uniqueID;
//   const trainDate = getFormattedDateTimeIST();

//   const posttestColumn = `course${courseID}Posttest`;
//   const courseNameColumn = `uCourse${courseID}`;
//   const trainDateColumn = `course${courseID}TrainDate`;

//   const query = `
//     UPDATE users 
//     SET ${posttestColumn} = ?, 
//         ${courseNameColumn} = ?, 
//         ${trainDateColumn} = ? 
//     WHERE uniqueID = ?
//   `;

//   console.log('Executing update with values:', {
//     posttestScore,
//     courseName,
//     trainDate,
//     uniqueID
//   });

//   connection.query(query, [posttestScore, courseName, trainDate, uniqueID], (error, results) => {
//     if (error) {
//       console.error('Error updating user SCORM data:', error);
//       return res.status(500).send('Internal Server Error');
//     }

//     if (results.affectedRows === 0) {
//       console.warn('Update query ran but no rows were affected');
//     } else {
//       console.log('Successfully updated with time:', trainDate);
//     }

//     res.sendStatus(200);
//   });
// });

// helpers
function safeCourseID(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error("bad courseID");
  return n;
}
function colUsersPosttest(courseID) { return `course${courseID}Posttest`; }
function colUsersCourseName(courseID) { return `uCourse${courseID}`; }
function colUsersTrainDate(courseID) { return `course${courseID}TrainDate`; }
function colCoursePosttest(courseID, attempt) { return `course_${courseID}_Posttest${attempt}`; }

app.post('/updateUserSCORMData', (req, res) => {
  try {
    if (!req.session?.user?.uniqueID) return res.status(401).send('User session not found');
    const { posttestScore = "", courseID, courseName = "" } = req.body;
    const cid = safeCourseID(courseID);
    const uniqueID = req.session.user.uniqueID;
    const trainDate = getFormattedDateTimeIST();

    const query = `
      UPDATE users
      SET ${colUsersPosttest(cid)} = ?,
          ${colUsersCourseName(cid)} = ?,
          ${colUsersTrainDate(cid)} = ?
      WHERE uniqueID = ?
    `;
    connection.query(query, [posttestScore, courseName, trainDate, uniqueID], (error, results) => {
      if (error) { console.error(error); return res.status(500).send('Internal Server Error'); }
      res.sendStatus(200);
    });
  } catch (e) {
    console.error(e);
    res.status(400).send('Bad Request');
  }
});

// app.post('/updateUserSCORMData', (req, res) => {
//   try {
//     if (!req.session?.user?.uniqueID) return res.status(401).send('User session not found');
//     const { posttestScore = "", courseID, courseName = "" } = req.body;
//     const cid = safeCourseID(courseID);
//     const uniqueID = req.session.user.uniqueID;
//     const trainDate = getFormattedDateTimeIST();

//     const query = `
//       UPDATE users
//       SET ${colUsersPosttest(cid)} = ?,
//           ${colUsersCourseName(cid)} = ?,
//           ${colUsersTrainDate(cid)} = ?
//       WHERE uniqueID = ?
//     `;
//     connection.query(query, [posttestScore, courseName, trainDate, uniqueID], (error, results) => {
//       if (error) { console.error(error); return res.status(500).send('Internal Server Error'); }
//       res.sendStatus(200);
//     });
//   } catch (e) {
//     console.error(e);
//     res.status(400).send('Bad Request');
//   }
// });



/*function getFormattedDateTimeIST() {
  const now = new Date();
  const istNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));

  const yyyy = istNow.getFullYear();
  const mm = String(istNow.getMonth() + 1).padStart(2, '0');
  const dd = String(istNow.getDate()).padStart(2, '0');
  const hh = String(istNow.getHours()).padStart(2, '0');
  const min = String(istNow.getMinutes()).padStart(2, '0');
  const ss = String(istNow.getSeconds()).padStart(2, '0');

  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
}*/

app.post('/updateUserSCORMData', (req, res) => {
  const { posttestScore, courseID, courseName } = req.body;
 
  if (!req.session || !req.session.user || !req.session.user.uniqueID) {
    return res.status(401).send('User session not found');
  }
 
  const uniqueID = req.session.user.uniqueID;
  const trainDate = getFormattedDateTimeIST();
 
  const posttestColumn = `course${courseID}Posttest`;
  const courseNameColumn = `uCourse${courseID}`;
  const trainDateColumn = `course${courseID}TrainDate`;
 
  // Step 1: Update users table with overall course score, name, date
  const updateUsersQuery = `
    UPDATE users 
    SET ${posttestColumn} = ?, 
        ${courseNameColumn} = ?, 
        ${trainDateColumn} = ? 
    WHERE uniqueID = ?
  `;
 
  connection.query(updateUsersQuery, [posttestScore, courseName, trainDate, uniqueID], (error, results) => {
    if (error) {
      console.error('Error updating users table:', error);
      return res.status(500).send('Internal Server Error');
    }
 
    // ✅ Step 2: Now fetch attempt number (noOfAttempts) for this user from course table
    const fetchAttemptsQuery = `SELECT noOfAttempts FROM course_${courseID} WHERE employeeID = ?`;
    connection.query(fetchAttemptsQuery, [uniqueID], (err2, result2) => {
      if (err2 || result2.length === 0) {
        console.error('Error fetching attempt number:', err2 || 'No data found');
        return res.status(500).send('Failed to get attempt number');
      }
 
      const attemptNumber = result2[0].noOfAttempts;
      const dateColumn = `date${attemptNumber}`;
 
      // ✅ Step 3: Update course_X.dateX with current timestamp
      const updateCourseDateQuery = `UPDATE course_${courseID} SET ${dateColumn} = ? WHERE employeeID = ?`;
      connection.query(updateCourseDateQuery, [trainDate, uniqueID], (err3, result3) => {
        if (err3) {
          console.error('Error updating course table date column:', err3);
          return res.status(500).send('Failed to update course attempt date');
        }
 
        console.log(`✅ Updated date for course_${courseID}.${dateColumn} = ${trainDate}`);
        return res.sendStatus(200); // All done!
      });
    });
  });
});






// Update user's SCORM data
app.post('/updateUserExcelData', (req, res) => {

  const { localPosttest, courseID, courseName } = req.body;
  const uniqueID = req.session.user.uniqueID;

  // // Use the currentCourseID global variable here
  // const query2 = `SELECT courseID FROM courses ORDER BY id DESC`;
  // Construct the column names dynamically based on the courseID
  const posttestColumn = `course${courseID}Posttest`;
  const courseNameColumn = `uCourse${courseID}`;
  console.log("uniqueID is: " + uniqueID);

  // Update the user's SCORM data in the database
  const query = `UPDATE users SET ${posttestColumn} = ?, ${courseNameColumn} = ? WHERE uniqueID = ?`;
  connection.query(query, [localPosttest, courseName, uniqueID], (error, results) => {
    if (error) {
      console.error('Error updating user SCORM data:', error);
      console.log("uniqueID is in error: " + uniqueID);
      return res.status(500).send('Internal Server Error');
    }
    console.log('User Excel data updated successfully');
    console.log('Result ', localPosttest, courseName, uniqueID);
    res.sendStatus(200);
  });
});



// Update user's SCORM data
/*app.post('/updateUserSCORMDataInCourseTable', (req, res) => {
 
  const { posttestScore, Score, Status, duration, courseID } = req.body;
  const uniqueID = req.session.user.uniqueID;
 
  // // Use the currentCourseID global variable here
  // const query2 = `SELECT courseID FROM courses ORDER BY id DESC`;
  // Construct the column names dynamically based on the courseID
  const posttestColumn = `course_${courseID}_Posttest1`;
  console.log("uniqueID is: " + uniqueID);
 
  // Update the user's SCORM data in the database
  const query = `UPDATE course_${courseID} SET ${posttestColumn} = ?, score1 = ?, status1 = ?, duration1 = ? WHERE uniqueID = ?`;
  connection.query(query, [posttestScore, Score, Status, duration, uniqueID], (error, results) => {
    if (error) {
      console.error('Error updating user SCORM data:', error);
      console.log("uniqueID is in error: " + uniqueID);
      return res.status(500).send('Internal Server Error');
    }
    console.log('User SCORM data updated successfully');
    res.sendStatus(200);
  });
});*/

//extra work 25-07-25

function getFormattedDateTimeIST() {
  const now = new Date();
  const istNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));

  const yyyy = istNow.getFullYear();
  const mm = String(istNow.getMonth() + 1).padStart(2, '0');
  const dd = String(istNow.getDate()).padStart(2, '0');
  const hh = String(istNow.getHours()).padStart(2, '0');
  const min = String(istNow.getMinutes()).padStart(2, '0');
  const ss = String(istNow.getSeconds()).padStart(2, '0');

  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
}


// Update user's SCORM data
/*app.post('/updateUserSCORMDataInCourseTable', (req, res) => {
  const { posttestScore, Score, Status, duration, date,courseID } = req.body;
  const uniqueID = req.session.user.uniqueID;
 
  // Query to get the current attempt count for the user
  const getAttemptQuery = `SELECT noOfAttempts FROM course_${courseID} WHERE uniqueID = ?`;
 
  connection.query(getAttemptQuery, [uniqueID], (error, results) => {
    if (error) {
      console.error('Error fetching attempt count:', error);
      return res.status(500).send('Internal Server Error');
    }
 
    let attempt = 1; // Default to 1 if no record exists
    if (results.length > 0) {
      attempt = results[0].noOfAttempts;
    }
 
    // Construct column names dynamically based on the current attempt
    const posttestColumn = `course_${courseID}_Posttest${attempt}`;
    const scoreColumn = `score${attempt}`;
    const statusColumn = `status${attempt}`;
    const durationColumn = `duration${attempt}`;
    const dateColumn=`date${attempt}`;
 
    // Update the user's SCORM data in the database
    const updateQuery = `
      UPDATE course_${courseID}
      SET ${posttestColumn} = ?, ${scoreColumn} = ?, ${statusColumn} = ?, ${durationColumn} = ?,${dateColumn}=? noOfAttempts = ?
      WHERE uniqueID = ?
    `;
 
    connection.query(updateQuery, [posttestScore, Score, Status, duration,date, attempt, uniqueID], (error, results) => {
      if (error) {
        console.error('Error updating user SCORM data:', error);
        return res.status(500).send('Internal Server Error');
      }
      console.log('User SCORM data updated successfully for attempt', attempt);
      res.sendStatus(200);
    });
  });
});*/


// Commented on 27-09-2025 3.05pm
// app.post('/updateUserSCORMDataInCourseTable', (req, res) => {
//   const { posttestScore, Score, Status, duration, courseID } = req.body;
//   const uniqueID = req.session.user.uniqueID;

//   const getAttemptQuery = `SELECT noOfAttempts FROM course_${courseID} WHERE uniqueID = ?`;

//   connection.query(getAttemptQuery, [uniqueID], (error, results) => {
//     if (error) {
//       console.error('Error fetching attempt count:', error);
//       return res.status(500).send('Internal Server Error');
//     }

//     let attempt = 1;
//     if (results.length > 0) {
//       attempt = results[0].noOfAttempts;
//     }

//     const posttestColumn = `course_${courseID}_Posttest${attempt}`;
//     const scoreColumn = `score${attempt}`;
//     const statusColumn = `status${attempt}`;
//     const durationColumn = `duration${attempt}`;
//     const dateColumn = `date${attempt}`;
//     const date = getFormattedDateTimeIST();  // ✅ Add date value here

//     const updateQuery = `
//       UPDATE course_${courseID}
//       SET ${posttestColumn} = ?,
//           ${scoreColumn} = ?,
//           ${statusColumn} = ?,
//           ${durationColumn} = ?,
//           ${dateColumn} = ?,
//           noOfAttempts = ?
//       WHERE uniqueID = ?
//     `;

//     const values = [posttestScore, Score, Status, duration, date, attempt, uniqueID];

//     connection.query(updateQuery, values, (error, results) => {
//       if (error) {
//         console.error('Error updating user SCORM data:', error);
//         return res.status(500).send('Internal Server Error');
//       }

//       console.log(`✅ SCORM data updated for attempt ${attempt} at ${date}`);
//       res.sendStatus(200);
//     });
//   });
// });

// app.post('/updateUserSCORMDataInCourseTable', (req, res) => {
//   try {
//     if (!req.session?.user?.uniqueID) return res.status(401).send('User session not found');

//     const { posttestScore = "", Score = "", Status = "", duration = "", courseID } = req.body;
//     const cid = safeCourseID(courseID);
//     const uniqueID = req.session.user.uniqueID;

//     const getAttemptQuery = `SELECT noOfAttempts FROM course_${cid} WHERE uniqueID = ?`;
//     connection.query(getAttemptQuery, [uniqueID], (error, results) => {
//       if (error) {
//         if (error.code === 'ER_NO_SUCH_TABLE') {
//           console.warn(`Course table course_${cid} is missing, dropping this SCORM packet`);
//           return res.status(410).send('Course table missing'); // or 204
//         }
//         console.error(error);
//         return res.status(500).send('Internal Server Error');
//       }
//       // if row missing, you may want to INSERT a seed row here
//       const attempt = results?.[0]?.noOfAttempts || 1;
//       const date = getFormattedDateTimeIST();

//       const updateQuery = `
//         UPDATE course_${cid}
//         SET ${colCoursePosttest(cid, attempt)} = ?,
//             score${attempt} = ?,
//             status${attempt} = ?,
//             duration${attempt} = ?,
//             date${attempt} = ?,
//             noOfAttempts = ?
//         WHERE uniqueID = ?
//       `;
//       connection.query(updateQuery, [posttestScore, Score, Status, duration, date, attempt, uniqueID], (error2) => {
//         if (error2) { console.error(error2); return res.status(500).send('Internal Server Error'); }
//         res.sendStatus(200);
//       });
//     });
//   } catch (e) {
//     console.error(e);
//     res.status(400).send('Bad Request');
//   }
// });


app.post('/updateUserSCORMDataInCourseTable', async (req, res) => {
  try {
    if (!req.session?.user?.uniqueID)
      return res.status(401).send('User session not found');

    const {
      posttestScore = "", Score = "", Status = "", duration = "",
      courseID, attemptId = "", source = "", reason = ""
    } = req.body;
    const uniqueID = req.session.user.uniqueID;

    // ✅ CHECK IF THIS IS A REFRESHAL COURSE
    if (courseID && courseID.startsWith('RF_')) {
      // Handle refreshal training separately
      const getAttemptQuery = `SELECT noOfAttempts, id FROM refreshaltrain WHERE courseID = ? AND uniqueID = ?`;

      connection.query(getAttemptQuery, [courseID, uniqueID], (error, results) => {
        if (error) {
          console.error('Error fetching refreshal attempt count:', error);
          return res.status(500).send('Internal Server Error');
        }

        if (results.length === 0) {
          console.error(`Refreshal training record not found for courseID: ${courseID}, uniqueID: ${uniqueID}`);
          return res.status(404).send('Refreshal training record not found');
        }

        const currentAttempts = results[0].noOfAttempts;
        const recordId = results[0].id;
        const attempt = currentAttempts + 1;

        if (attempt > 27) {
          return res.status(400).send('Maximum attempts (27) reached');
        }

        const date = getFormattedDateTimeIST();

        const updateQuery = `
          UPDATE refreshaltrain
          SET course_Posttest${attempt} = ?,
              score${attempt} = ?,
              status${attempt} = ?,
              duration${attempt} = ?,
              date${attempt} = ?,
              noOfAttempts = ?
          WHERE courseID = ?
        `;

        connection.query(
          updateQuery,
          [posttestScore, Score, Status, duration, date, attempt, recordId],
          (error2) => {
            if (error2) {
              console.error('Error updating refreshal data:', error2);
              return res.status(500).send('Internal Server Error');
            }

            console.log(`✅ Refreshal training data updated for attempt ${attempt}`);
            res.json({
              success: true,
              message: 'Refreshal training updated successfully',
              attempt: attempt
            });
          }
        );
      });

      return; // Exit early for refreshal courses
    }

    // SCORM publishes many progress packets while a course is running. Blank
    // status + score 0 is not a failed attempt. Persist only a terminal
    // packet, otherwise an intermediate packet can lock the refresher before
    // the real final score arrives.
    const normalizedScormStatus = String(Status || '').trim().toLowerCase();
    const normalizedScormReason = String(reason || '').trim().toLowerCase();
    const terminalStatuses = new Set(['passed', 'pass', 'failed', 'fail', 'completed']);
    const isTerminalScormPacket =
      terminalStatuses.has(normalizedScormStatus)
      || normalizedScormReason.includes('finish')
      || normalizedScormReason.includes('terminate');
    if (!isTerminalScormPacket) {
      return res.status(202).json({ success: true, saved: false, progressOnly: true });
    }

    // ✅ REGULAR COURSE HANDLING
    // SCORM-package courses are graded exactly like assessment-type courses -
    // a normalized courseattempts + coursegrades row, with Pass/Fail computed
    // from subcourses.subCoursePassing - the same rule /submitPosttestData
    // already uses for the Excel-quiz flow. This used to write into a
    // separate per-course legacy table; that mechanism is gone, so SCORM
    // scores now flow through the same path the Grades Report already reads
    // for assessment courses, with no separate handling needed there.
    // courseID here is the subCourseID value /getViewscormCourseList already
    // hands to the player - this route's request/response contract is
    // otherwise unchanged, so scormview.html needs no changes.
    const subCourseID = safeCourseID(courseID);
    const db = connection.promise();

    // ✅ REFRESHER SCORM (new skill-matrix refresher flow, distinct from the
    // legacy RF_ / refreshaltrain mechanism above). Flagged explicitly by the
    // caller via source: 'refresher' (see public/scormview.html sendPacket) -
    // refresher content lives in its own table space (refresher_subcourses /
    // refresher_courseattempts / refresher_coursegrades) with an
    // independently auto-incrementing subCourseID, so it cannot be told apart
    // from a regular course by ID alone.
    const isRefresher = source === 'refresher';
    const courseTable = isRefresher ? 'refresher_subcourses' : 'subcourses';
    const attemptsTable = isRefresher ? 'refresher_courseattempts' : 'courseattempts';
    const gradesTable = isRefresher ? 'refresher_coursegrades' : 'coursegrades';

    const [courseRows] = await db.query(
      `SELECT subCourseID, deptID, areaID, mCourseID, coMCourseID, subCourseLevel, subCoursePassing
       FROM ${courseTable} WHERE subCourseID = ? LIMIT 1`,
      [subCourseID]
    );
    if (!courseRows.length) {
      console.warn(`SCORM packet for unknown subCourseID ${subCourseID} (source=${source || 'regular'}), dropping`);
      return res.status(404).send('Course not found');
    }
    const course = courseRows[0];

    const numericScore = Number((Score !== '' && Score !== undefined && Score !== null) ? Score : posttestScore) || 0;
    const scormPassingScope = isRefresher ? 'refresher' : scopeForSubcourseLevel(course.subCourseLevel);
    const passingThreshold = await resolveEffectiveThreshold(scormPassingScope, course.subCoursePassing);
    const status = numericScore >= passingThreshold ? 'Pass' : 'Fail';

    if (!isRefresher) {
      const [lockRows] = await db.query(
        `SELECT locked FROM refresher_course_locks
         WHERE uniqueID = ? AND subCourseID = ? AND locked = 1 LIMIT 1`,
        [uniqueID, subCourseID]
      );
      if (lockRows.length) {
        return res.status(423).send('This refresher course is locked. Ask an administrator to select Retrain.');
      }
    }

    const now = getFormattedDateTimeIST();
    const [courseDate, courseTime] = now.split(' ');

    const scormAttemptKey = String(attemptId || '').trim().slice(0, 250);
    let currentAttempt = null;
    if (scormAttemptKey) {
      const [existingAttemptRows] = await db.query(
        `SELECT attemptID, noOfAttempts FROM ${attemptsTable}
         WHERE uniqueID = ? AND subCourseID = ? AND attemptRemark = ?
         ORDER BY attemptID DESC LIMIT 1`,
        [uniqueID, subCourseID, scormAttemptKey]
      );
      currentAttempt = existingAttemptRows[0] || null;
    }

    const [attemptCountRows] = await db.query(
      `SELECT COALESCE(MAX(noOfAttempts), 0) + 1 AS nextAttempt FROM ${attemptsTable} WHERE uniqueID = ? AND subCourseID = ?`,
      [uniqueID, subCourseID]
    );
    const nextAttempt = currentAttempt?.noOfAttempts || attemptCountRows[0]?.nextAttempt || 1;
    const MAX_ATTEMPTS = 27;
    if (nextAttempt > MAX_ATTEMPTS) return res.status(400).send('Maximum attempts reached');

    if (currentAttempt) {
      const attemptID = currentAttempt.attemptID;
      await db.query(
        `UPDATE ${attemptsTable}
         SET pretestScore = ?, score = ?, status = ?, duration = ?, courseDate = ?, courseTime = ?
         WHERE attemptID = ?`,
        [null, numericScore, status, String(duration || 0), courseDate, courseTime, attemptID]
      );
      const [gradeRows] = await db.query(
        `SELECT id FROM ${gradesTable} WHERE attemptID = ? ORDER BY id DESC LIMIT 1`,
        [attemptID]
      );
      if (gradeRows.length) {
        await db.query(
          `UPDATE ${gradesTable}
           SET pretestScore = ?, score = ?, status = ?, duration = ?, courseDate = ?, courseTime = ?
           WHERE id = ?`,
          [null, numericScore, status, String(duration || 0), courseDate, courseTime, gradeRows[0].id]
        );
      } else {
        await db.query(
          `INSERT INTO ${gradesTable}
             (deptID, areaID, mCourseID, coMCourseID, subCourseID, uniqueID, attemptID, noOfAttempts,
              pretestScore, score, status, duration, courseDate, courseTime)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            course.deptID, course.areaID, course.mCourseID, course.coMCourseID, subCourseID,
            uniqueID, attemptID, nextAttempt, null, numericScore, status, String(duration || 0), courseDate, courseTime
          ]
        );
      }
    } else {
      const [attemptInsertResult] = await db.query(
        `INSERT INTO ${attemptsTable}
           (deptID, areaID, mCourseID, coMCourseID, subCourseID, uniqueID, noOfAttempts,
            pretestScore, score, status, duration, courseDate, courseTime, attemptRemark)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          course.deptID, course.areaID, course.mCourseID, course.coMCourseID, subCourseID,
          uniqueID, nextAttempt, null, numericScore, status, String(duration || 0), courseDate, courseTime,
          scormAttemptKey || null
        ]
      );
      const attemptID = attemptInsertResult.insertId;

      await db.query(
        `INSERT INTO ${gradesTable}
           (deptID, areaID, mCourseID, coMCourseID, subCourseID, uniqueID, attemptID, noOfAttempts,
            pretestScore, score, status, duration, courseDate, courseTime)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          course.deptID, course.areaID, course.mCourseID, course.coMCourseID, subCourseID,
          uniqueID, attemptID, nextAttempt, null, numericScore, status, String(duration || 0), courseDate, courseTime
        ]
      );
    }

    if (!isRefresher && status === 'Fail') {
      await lockCourseIfCurrentRefresherIsDue(uniqueID, subCourseID);
    }
    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.status(400).send('Bad Request');
  }
});





// Update user's SCORM data
app.post('/updateUserEXCELDataInCourseTable', (req, res) => {
  const { localPosttest, localScore, localStatus, localduration, localDate, courseID } = req.body;
  const uniqueID = req.session.user.uniqueID;

  // Query to get the current attempt count for the user
  const getAttemptQuery = `SELECT noOfAttempts FROM course_${courseID} WHERE uniqueID = ?`;

  connection.query(getAttemptQuery, [uniqueID], (error, results) => {
    if (error) {
      console.error('Error fetching attempt count:', error);
      return res.status(500).send('Internal Server Error');
    }

    let attempt = 1; // Default to 1 if no record exists
    if (results.length > 0) {
      attempt = results[0].noOfAttempts;
    }

    // Construct column names dynamically based on the current attempt
    const posttestColumn = `course_${courseID}_Posttest${attempt}`;
    const scoreColumn = `score${attempt}`;
    const statusColumn = `status${attempt}`;
    const durationColumn = `duration${attempt}`;
    const dateColumn = `date${attempt}`;

    // Update the user's SCORM data in the database
    const updateQuery = `
      UPDATE course_${courseID}
      SET ${posttestColumn} = ?, ${scoreColumn} = ?, ${statusColumn} = ?, ${durationColumn} = ?, ${dateColumn}=? , noOfAttempts = ?
      WHERE uniqueID = ?
    `;

    connection.query(updateQuery, [localPosttest, localScore, localStatus, localduration, localDate, attempt, uniqueID], (error, results) => {
      if (error) {
        console.error('Error updating user SCORM data:', error);
        return res.status(500).send('Internal Server Error');
      }
      console.log('User SCORM data updated successfully for attempt', attempt);
      res.sendStatus(200);
    });
  });
});






// Update user's attempt count
// Update user's attempt count - FIXED VERSION
app.get('/updateAttempt', (req, res) => {
  const courseID = req.query.courseID;
  const uniqueID = req.session.user.uniqueID;

  // ✅ CHECK IF THIS IS A REFRESHAL COURSE
  if (courseID && courseID.startsWith('RF_')) {
    // This is refreshal training - use refreshaltrain table
    const query = `UPDATE refreshaltrain SET noOfAttempts = noOfAttempts + 1 WHERE courseID = ? AND uniqueID = ?`;

    connection.query(query, [courseID, uniqueID], (error, results) => {
      if (error) {
        console.error('Error updating refreshal attempt count:', error);
        return res.status(500).send('Internal Server Error');
      }

      if (results.affectedRows === 0) {
        console.warn(`No refreshal training record found for courseID: ${courseID}, uniqueID: ${uniqueID}`);
        return res.status(404).json({ success: false, message: 'Refreshal training record not found' });
      }

      console.log('Refreshal attempt count updated successfully');
      console.log('Refreshal Course ID: ' + courseID);
      res.json({ success: true });
    });
  } else {
    // Regular course - use course_${courseID} table
    const query = `UPDATE course_${courseID} SET noOfAttempts = noOfAttempts + 1 WHERE uniqueID = ?`;

    connection.query(query, [uniqueID], (error, results) => {
      if (error) {
        console.error('Error updating attempt count:', error);
        return res.status(500).send('Internal Server Error');
      }
      console.log('Attempt count updated successfully');
      console.log('Course ID from index fn: ' + courseID);
      res.json({ success: true });
    });
  }
});






// Middleware to check if the user is authenticated
function requireAuth(req, res, next, username) {
  if (req.session && req.session.user && req.session.user.username === username) {
    // User is authenticated, proceed to the next middleware/route handler
    next();
  } else {
    // User is not authenticated, redirect to the login page
    res.redirect('/home.html'); // Redirect to the appropriate login page
  }
}

// Apply requireAuth middleware to routes that require authentication
app.use(['/addUser.html', '/courseManagement.html', '/lmshomepage.html', '/scormview.html', '/viewscorm.html'], requireAuth);

// Routes for pages where users can go without logging in
app.get(['/home.html', '/userlogin.html', '/adminlogin.html', '/managerlogin.html', '/employeelogin.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', req.path));
});

// Employee login route
app.post('/employeelogin', (req, res) => {
  // Your existing login logic
});






// Course Details Page
// Route to get course details by ID
app.get('/course/:courseID', (req, res) => {
  const courseID = req.params.courseID;

  const normalizedQuery = `
    SELECT
      sc.subCourseName AS courseName,
      sc.subCourseDescription AS courseDescription,
      sc.subCourseDate AS courseDate,
      sc.subCourseLevel AS level,
      sc.courseType,
      sc.contentType,
      d.deptName AS departmentName,
      a.areaName,
      m.mCourseName
    FROM subcourses sc
    LEFT JOIN departments d ON d.deptID = sc.deptID
    LEFT JOIN areas a ON a.areaID = sc.areaID
    LEFT JOIN mcourses m ON m.mCourseID = sc.mCourseID
    WHERE sc.subCourseID = ?
    LIMIT 1
  `;

  connection.query(normalizedQuery, [courseID], (normalizedError, normalizedResults) => {
    if (!normalizedError) {
      if (normalizedResults.length > 0) {
        return res.json(normalizedResults[0]);
      }
      return res.status(404).send('Course not found');
    }

    if (!shouldFallbackToLegacySchema(normalizedError)) {
      console.error('Error fetching normalized course details:', normalizedError);
      return res.status(500).send('Internal Server Error');
    }

    const query = `SELECT courseName, courseDescription, courseDate, level FROM courses WHERE courseID = ?`;
    connection.query(query, [courseID], (error, results) => {
      if (error) {
        console.error('Error fetching course details:', error);
        return res.status(500).send('Internal Server Error');
      }

      if (results.length > 0) {
        res.json(results[0]);
      } else {
        res.status(404).send('Course not found');
      }
    });
  });
});

// Deletes a learner from learnersList.html. Requires a deletion `reason` in
// the JSON body - before the row is removed from `users`, it's snapshotted
// (along with the reason and who deleted it) into `deletedusers` so it shows
// up on the Past Users list instead of just disappearing.
function normalizeAuditDate(value) {
  if (value == null || String(value).trim() === '') return null;
  const raw = String(value).trim();
  const indianDate = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(.*))?$/);
  if (indianDate) {
    const [, day, month, year, time] = indianDate;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')} ${time || '00:00:00'}`;
  }
  const isoDate = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s]+(.*))?$/);
  if (isoDate) {
    const [, year, month, day, time] = isoDate;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')} ${(time || '00:00:00').replace('Z', '')}`;
  }
  // Unknown legacy text should not prevent deletion. The original learner
  // fields are still preserved; only an unparseable audit date stays blank.
  return null;
}

app.delete('/deleteUser/:uniqueID', express.json(), (req, res) => {
  const uniqueID = req.params.uniqueID;
  const reason = (req.body && req.body.reason || '').trim();

  if (!reason) {
    return res.status(400).json({ success: false, message: 'A reason for deletion is required.' });
  }

  const deletedBy = (req.session && req.session.user) ? req.session.user.uniqueID : null;
  const deletedByName = (req.session && req.session.user) ? req.session.user.username : null;

  connection.query('SELECT * FROM users WHERE uniqueID = ?', [uniqueID], (selectError, rows) => {
    if (selectError) {
      console.error('Error looking up user before delete:', selectError);
      return res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const user = rows[0];
    const snapshotQuery = `
      INSERT INTO deletedusers
        (originalUniqueID, name, emailID, employeeID, uName, uPass, mobileNo, department, uRole, registerDate, reason, deletedBy, deletedByName)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const snapshotValues = [
      user.uniqueID, user.name, user.emailID, user.employeeID, user.uName, user.uPass,
      user.mobileNo, user.department, user.uRole, normalizeAuditDate(user.registerDate),
      reason, deletedBy, deletedByName
    ];

    connection.query(snapshotQuery, snapshotValues, (snapshotError) => {
      if (snapshotError) {
        console.error('Error saving deleted-user snapshot:', snapshotError);
        return res.status(500).json({ success: false, message: 'Could not record deletion reason; user was not deleted.' });
      }

      connection.query('DELETE FROM users WHERE uniqueID = ?', [uniqueID], (deleteError) => {
        if (deleteError) {
          console.error('Error deleting user:', deleteError);
          return res.status(500).json({ success: false, message: 'Internal Server Error' });
        }
        res.json({ success: true });
      });
    });
  });
});

// Past Users: everyone deleted from learnersList.html, most recent first.
app.get('/api/pastUsers', (req, res) => {
  connection.query('SELECT * FROM deletedusers ORDER BY deletedDate DESC', (error, rows) => {
    if (error) {
      console.error('Error fetching past users:', error);
      return res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
    res.json({ success: true, users: rows });
  });
});


// Route for retrieving user data from the database
app.get('/courseDetailsUserData', (req, res) => {
  const courseID = req.query.courseID; // Get courseID from query parameter

  if (!courseID) {
    return res.status(400).json({ error: 'Course ID is required' });
  }

  // Dynamically construct the column name for the training date
  const trainDateColumn = `course${courseID}TrainDate`;

  // Query to retrieve user data including the training date for the specific course
  const query = `SELECT uniqueID, name, employeeID, uName, dateOfJoining, department, currentDate FROM users`;

  connection.query(query, (error, results) => {
    if (error) {
      console.error('Error retrieving user data:', error);
      return res.status(500).send('Internal Server Error');
    }

    // Process results to add expiration status
    const processedResults = results.map(user => {
      let isExpired = false;
      let daysUntilExpiry = null;

      if (user.trainingDate) {
        const trainDate = new Date(user.trainingDate);
        const currentDate = new Date();

        // Calculate 3 months from training date
        const expiryDate = new Date(trainDate);
        expiryDate.setMonth(expiryDate.getMonth() + 3);

        // Check if training has expired (3 months or more have passed)
        isExpired = currentDate >= expiryDate;

        // Calculate days until expiry
        const timeDiff = expiryDate - currentDate;
        daysUntilExpiry = Math.ceil(timeDiff / (1000 * 60 * 60 * 24));
      }

      return {
        ...user,
        isExpired,
        daysUntilExpiry
      };
    });

    res.json(processedResults);
  });
});





app.post('/enrollUsersToCourse/:courseID', (req, res) => {
  const courseID = req.params.courseID;
  const selectedUsers = req.body.users;

  if (selectedUsers && selectedUsers.length > 0) {
    const hierarchyQuery = `
      SELECT deptID, areaID, mCourseID, coMCourseID, subCourseID
      FROM subcourses
      WHERE subCourseID = ?
      LIMIT 1
    `;

    connection.query(hierarchyQuery, [courseID], (hierarchyError, hierarchyRows) => {
      if (!hierarchyError) {
        if (hierarchyRows.length === 0) {
          return res.status(404).json({ message: 'Course not found' });
        }

        const course = hierarchyRows[0];
        const userUniqueIDs = selectedUsers.map(user => user.uniqueID);
        const checkQuery = `
          SELECT uniqueID
          FROM enrollstatus
          WHERE subCourseID = ?
            AND uniqueID IN (?)
            AND COALESCE(enrollStatus, 'Active') IN ('Active', 'active', 'Enrolled', 'enrolled')
        `;

        connection.query(checkQuery, [course.subCourseID, userUniqueIDs], (checkError, existingRows) => {
          if (checkError) {
            console.error('Error checking normalized enrollment:', checkError);
            return res.status(500).send('Error checking existing users');
          }

          const enrolledUserIDs = existingRows.map(row => String(row.uniqueID));
          const newUsers = selectedUsers.filter(user => !enrolledUserIDs.includes(String(user.uniqueID)));

          if (newUsers.length === 0) {
            return res.json({ message: 'All selected users are already enrolled.' });
          }

          const enrollDate = new Date().toISOString().slice(0, 10);
          const values = newUsers.map(user => [
            user.uniqueID,
            course.deptID,
            course.areaID,
            course.mCourseID,
            course.coMCourseID,
            course.subCourseID,
            enrollDate,
            enrollDate,
            null,
            'Active',
            null,
            null
          ]);

          const insertQuery = `
            INSERT INTO enrollstatus
              (uniqueID, deptID, areaID, mCourseID, coMCourseID, subCourseID, enrollDate, startDate, endDate, enrollStatus, multiSkill, activeTrainingStations)
            VALUES ?
          `;

          connection.query(insertQuery, [values], (insertError, insertResults) => {
            if (insertError) {
              console.error('Error enrolling normalized users:', insertError);
              return res.status(500).send('Error enrolling new users');
            }

            const message = enrolledUserIDs.length > 0
              ? 'Some users were already enrolled.'
              : 'Users enrolled successfully';

            res.json({ message, results: insertResults });
          });
        });
        return;
      }

      if (!shouldFallbackToLegacySchema(hierarchyError)) {
        console.error('Error loading normalized course hierarchy:', hierarchyError);
        return res.status(500).send('Error checking course hierarchy');
      }

      enrollUsersToLegacyCourse(courseID, selectedUsers, res);
    });
  } else {
    res.status(400).send('No users selected for enrollment');
  }
});

function enrollUsersToLegacyCourse(courseID, selectedUsers, res) {
  if (selectedUsers && selectedUsers.length > 0) {
    // Get unique IDs of selected users
    const userUniqueIDs = selectedUsers.map(user => user.uniqueID);

    // Check which users are already enrolled in the course
    const checkQuery = `SELECT uniqueID FROM course_${courseID} WHERE uniqueID IN (?)`;
    connection.query(checkQuery, [userUniqueIDs], (checkError, results) => {
      if (checkError) {
        console.error('Error checking existing users:', checkError);
        return res.status(500).send('Error checking existing users');
      }

      // Get the IDs of already enrolled users
      const enrolledUserIDs = results.map(row => row.uniqueID);

      // Filter out users already enrolled
      const newUsers = selectedUsers.filter(user => !enrolledUserIDs.includes(user.uniqueID));

      if (newUsers.length > 0) {
        const values = newUsers.map(user => [user.uniqueID, user.employeeID, user.name]);
        const insertQuery = `INSERT INTO course_${courseID} (uniqueID, employeeID, name) VALUES ?`;

        connection.query(insertQuery, [values], (insertError, insertResults) => {
          if (insertError) {
            console.error('Error enrolling new users:', insertError);
            return res.status(500).send('Error enrolling new users');
          }

          const message = enrolledUserIDs.length > 0
            //? `Some users were already enrolled and skipped: ${enrolledUserIDs.join(', ')}`
            ? `Some users were already enrolled.`
            : 'Users enrolled successfully';
          res.json({ message, results: insertResults });
        });
      } else {
        res.json({ message: 'All selected users are already enrolled.' });
      }
    });
  } else {
    res.status(400).send('No users selected for enrollment');
  }
}
// Get enrolled users for a specific course
app.get('/getEnrolledUsers/:courseID', (req, res) => {
  const courseID = req.params.courseID;

  const normalizedQuery = `
    SELECT DISTINCT u.uniqueID, u.employeeID, u.name
    FROM enrollstatus es
    JOIN users u ON u.uniqueID = es.uniqueID
    WHERE es.subCourseID = ?
      AND COALESCE(es.enrollStatus, 'Active') IN ('Active', 'active', 'Enrolled', 'enrolled')
  `;

  connection.query(normalizedQuery, [courseID], (normalizedError, normalizedResults) => {
    if (!normalizedError) {
      return res.json({
        success: true,
        enrolledUsers: normalizedResults
      });
    }

    if (!shouldFallbackToLegacySchema(normalizedError)) {
      console.error('Error fetching normalized enrolled users:', normalizedError);
      return res.status(500).json({
        success: false,
        message: 'Error fetching enrolled users'
      });
    }

    const query = `SELECT uniqueID, employeeID, name FROM course_${courseID}`;

    connection.query(query, (error, results) => {
      if (error) {
        console.error('Error fetching enrolled users:', error);
        return res.status(500).json({
          success: false,
          message: 'Error fetching enrolled users'
        });
      }

      res.json({
        success: true,
        enrolledUsers: results
      });
    });
  });
});

// Unenroll users from course
app.post('/unenrollUsersFromCourse/:courseID', (req, res) => {
  const courseID = req.params.courseID;
  const selectedUsers = req.body.users;

  if (selectedUsers && selectedUsers.length > 0) {
    const userUniqueIDs = selectedUsers.map(user => user.uniqueID);

    const normalizedDeleteQuery = `
      UPDATE enrollstatus
      SET enrollStatus = 'Inactive', endDate = CURDATE()
      WHERE subCourseID = ?
        AND uniqueID IN (?)
    `;

    connection.query(normalizedDeleteQuery, [courseID, userUniqueIDs], (normalizedError, normalizedResults) => {
      if (!normalizedError) {
        const unenrolledCount = normalizedResults.affectedRows;
        return res.json({
          success: true,
          message: `${unenrolledCount} user(s) unenrolled successfully.`,
          unenrolledCount: unenrolledCount
        });
      }

      if (!shouldFallbackToLegacySchema(normalizedError)) {
        console.error('Error unenrolling normalized users:', normalizedError);
        return res.status(500).json({
          success: false,
          message: 'Error unenrolling users'
        });
      }

      // Delete users from the course table
      const deleteQuery = `DELETE FROM course_${courseID} WHERE uniqueID IN (?)`;

      connection.query(deleteQuery, [userUniqueIDs], (deleteError, results) => {
        if (deleteError) {
          console.error('Error unenrolling users:', deleteError);
          return res.status(500).json({
            success: false,
            message: 'Error unenrolling users'
          });
        }

        const unenrolledCount = results.affectedRows;

        res.json({
          success: true,
          message: `${unenrolledCount} user(s) unenrolled successfully.`,
          unenrolledCount: unenrolledCount
        });
      });
    });
  } else {
    res.status(400).json({
      success: false,
      message: 'No users selected for unenrollment'
    });
  }
});









// Add a route to get user's grades
// NOTE: This used to query the legacy `courses` / `course_<id>` tables, which
// are no longer written to now that attempts flow through
// subcourses + coursegrades/traininggrades (see /getViewscormCourseList,
// /submitPosttestData, /api/training-material/:subCourseID/complete). Rebuilt
// on that same modern schema/visibility rules (Level 1 always visible, Level
// 2+ only once enrolled - see /getViewscormCourseList for the reference
// query) so grades actually reflect real attempts, and so each row carries
// `courseLevel` for level-wise grouping on the My Grades page.
app.get('/getMyGrades', async (req, res) => {
  try {
    if (!req.session || !req.session.user || !req.session.user.uniqueID) {
      return res.status(401).json({ success: false, message: 'Not authenticated' });
    }
    const uniqueID = req.session.user.uniqueID;

    console.log(`Fetching grades for user: ${uniqueID}`);

    const userQuery = 'SELECT uniqueID, name, uName, employeeID, dateOfJoining, department, Contract FROM users WHERE uniqueID = ?';

    connection.query(userQuery, [uniqueID], (userError, userResults) => {
      if (userError) {
        console.error('Error fetching user data:', userError);
        return res.status(500).json({ success: false, message: 'Internal Server Error' });
      }

      if (userResults.length === 0) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }

      const user = userResults[0];
      const userDetails = {
        uniqueID: user.uniqueID,
        name: user.name,
        uName: user.uName,
        employeeID: user.employeeID,
        dateOfJoining: user.dateOfJoining,
        department: user.department,
        Contract: user.Contract
      };

      const gradesQuery = `
        SELECT DISTINCT
          sc.subCourseID AS courseID,
          sc.subCourseName AS courseName,
          sc.subCourseLevel AS courseLevel,
          sc.courseType,
          'regular' AS source,
          COALESCE(
            (SELECT cg.status FROM coursegrades cg WHERE cg.uniqueID = ? AND cg.subCourseID = sc.subCourseID ORDER BY cg.id DESC LIMIT 1),
            (SELECT pe.finalResult FROM practicalevaluations pe WHERE pe.uniqueID = ? AND pe.subCourseID = sc.subCourseID AND pe.evaluationStatus = 'Submitted' LIMIT 1),
            (SELECT tg.status FROM traininggrades tg WHERE tg.uniqueID = ? AND tg.subCourseID = sc.subCourseID ORDER BY tg.id DESC LIMIT 1),
            'No Attempt'
          ) AS status,
          COALESCE(
            (SELECT cg.score FROM coursegrades cg WHERE cg.uniqueID = ? AND cg.subCourseID = sc.subCourseID ORDER BY cg.id DESC LIMIT 1),
            (SELECT pe.finalPercent FROM practicalevaluations pe WHERE pe.uniqueID = ? AND pe.subCourseID = sc.subCourseID AND pe.evaluationStatus = 'Submitted' LIMIT 1),
            (SELECT tg.score FROM traininggrades tg WHERE tg.uniqueID = ? AND tg.subCourseID = sc.subCourseID ORDER BY tg.id DESC LIMIT 1)
          ) AS score
        FROM subcourses sc
        WHERE sc.subCourseLevel = 'Level 1'
          AND (
            sc.subCourseRoles IS NULL
            OR TRIM(sc.subCourseRoles) = ''
            OR FIND_IN_SET(
              TRIM((SELECT u.uRole FROM users u WHERE u.uniqueID = ? LIMIT 1)),
              sc.subCourseRoles
            ) > 0
          )

        UNION

        SELECT DISTINCT
          sc.subCourseID AS courseID,
          sc.subCourseName AS courseName,
          sc.subCourseLevel AS courseLevel,
          sc.courseType,
          'regular' AS source,
          COALESCE(
            (SELECT cg.status FROM coursegrades cg WHERE cg.uniqueID = es.uniqueID AND cg.subCourseID = sc.subCourseID ORDER BY cg.id DESC LIMIT 1),
            (SELECT pe.finalResult FROM practicalevaluations pe WHERE pe.uniqueID = es.uniqueID AND pe.subCourseID = sc.subCourseID AND pe.evaluationStatus = 'Submitted' LIMIT 1),
            (SELECT tg.status FROM traininggrades tg WHERE tg.uniqueID = es.uniqueID AND tg.subCourseID = sc.subCourseID ORDER BY tg.id DESC LIMIT 1),
            'No Attempt'
          ) AS status,
          COALESCE(
            (SELECT cg.score FROM coursegrades cg WHERE cg.uniqueID = es.uniqueID AND cg.subCourseID = sc.subCourseID ORDER BY cg.id DESC LIMIT 1),
            (SELECT pe.finalPercent FROM practicalevaluations pe WHERE pe.uniqueID = es.uniqueID AND pe.subCourseID = sc.subCourseID AND pe.evaluationStatus = 'Submitted' LIMIT 1),
            (SELECT tg.score FROM traininggrades tg WHERE tg.uniqueID = es.uniqueID AND tg.subCourseID = sc.subCourseID ORDER BY tg.id DESC LIMIT 1)
          ) AS score
        FROM enrollstatus es
        JOIN subcourses sc
          ON sc.deptID = es.deptID
         AND (es.areaID IS NULL OR sc.areaID = es.areaID)
         AND (es.mCourseID IS NULL OR sc.mCourseID = es.mCourseID)
         AND (es.coMCourseID IS NULL OR sc.coMCourseID = es.coMCourseID)
         AND (es.subCourseID IS NULL OR sc.subCourseID = es.subCourseID)
         AND (es.stationID = 0 OR sc.stationID = 0 OR sc.stationID = es.stationID)
        WHERE es.uniqueID = ?
          AND COALESCE(es.enrollStatus, 'Active') IN ('Active', 'active', 'Enrolled', 'enrolled')
          AND (
            sc.subCourseLevel IS NULL
            OR sc.subCourseLevel IN ('Level 1', 'Level 2', 'default')
            OR (
              sc.subCourseLevel = 'Level 3'
              AND EXISTS (
                SELECT 1 FROM skillmatrix_station_skills sms
                WHERE sms.uniqueID = es.uniqueID
                  AND sms.deptID = es.deptID
                  AND sms.areaID = es.areaID
                  AND sms.mCourseID = es.mCourseID
                  AND (sms.stationID = 0 OR es.stationID = 0 OR sms.stationID = es.stationID)
                  AND sms.requiredLevel >= 3
              )
              AND EXISTS (
                SELECT 1 FROM l2completedusers l2
                WHERE l2.uniqueID = es.uniqueID
                  AND l2.mCourseID = es.mCourseID
                  AND (l2.stationID = 0 OR es.stationID = 0 OR l2.stationID = es.stationID)
                  AND l2.l2Status = 'Pass'
              )
            )
            OR (
              sc.subCourseLevel = 'Level 4'
              AND EXISTS (
                SELECT 1 FROM skillmatrix_station_skills sms
                WHERE sms.uniqueID = es.uniqueID
                  AND sms.deptID = es.deptID
                  AND sms.areaID = es.areaID
                  AND sms.mCourseID = es.mCourseID
                  AND (sms.stationID = 0 OR es.stationID = 0 OR sms.stationID = es.stationID)
                  AND sms.requiredLevel >= 4
              )
              AND EXISTS (
                SELECT 1 FROM l3completedusers l3
                WHERE l3.uniqueID = es.uniqueID
                  AND l3.mCourseID = es.mCourseID
                  AND (l3.stationID = 0 OR es.stationID = 0 OR l3.stationID = es.stationID)
                  AND l3.l3Status = 'Pass'
              )
            )
          )

        UNION

        SELECT DISTINCT
          sc.subCourseID AS courseID,
          sc.subCourseName AS courseName,
          sc.subCourseLevel AS courseLevel,
          sc.courseType,
          'regular' AS source,
          COALESCE(
            (SELECT cg.status FROM coursegrades cg WHERE cg.uniqueID = ? AND cg.subCourseID = sc.subCourseID ORDER BY cg.id DESC LIMIT 1),
            (SELECT pe.finalResult FROM practicalevaluations pe WHERE pe.uniqueID = ? AND pe.subCourseID = sc.subCourseID AND pe.evaluationStatus = 'Submitted' LIMIT 1),
            (SELECT tg.status FROM traininggrades tg WHERE tg.uniqueID = ? AND tg.subCourseID = sc.subCourseID ORDER BY tg.id DESC LIMIT 1),
            'No Attempt'
          ) AS status,
          COALESCE(
            (SELECT cg.score FROM coursegrades cg WHERE cg.uniqueID = ? AND cg.subCourseID = sc.subCourseID ORDER BY cg.id DESC LIMIT 1),
            (SELECT pe.finalPercent FROM practicalevaluations pe WHERE pe.uniqueID = ? AND pe.subCourseID = sc.subCourseID AND pe.evaluationStatus = 'Submitted' LIMIT 1),
            (SELECT tg.score FROM traininggrades tg WHERE tg.uniqueID = ? AND tg.subCourseID = sc.subCourseID ORDER BY tg.id DESC LIMIT 1)
          ) AS score
        FROM subcourses sc
        WHERE sc.mCourseID IS NULL
          AND sc.subCourseLevel IN ('Level 2', 'Level 3', 'Level 4')
          AND EXISTS (
            SELECT 1 FROM enrollstatus es2
            WHERE es2.uniqueID = ?
              AND es2.coMCourseID IS NULL AND es2.subCourseID IS NULL
              AND COALESCE(es2.enrollStatus, 'Active') IN ('Active', 'active', 'Enrolled', 'enrolled')
              AND (
                sc.subCourseLevel = 'Level 2'
                OR (
                  sc.subCourseLevel = 'Level 3'
                  AND EXISTS (
                    SELECT 1 FROM skillmatrix_station_skills sms
                    WHERE sms.uniqueID = es2.uniqueID
                      AND sms.deptID = es2.deptID
                      AND sms.areaID = es2.areaID
                      AND sms.mCourseID = es2.mCourseID
                      AND (sms.stationID = 0 OR es2.stationID = 0 OR sms.stationID = es2.stationID)
                      AND sms.requiredLevel >= 3
                  )
                  AND EXISTS (
                    SELECT 1 FROM l2completedusers l2
                    WHERE l2.uniqueID = es2.uniqueID
                      AND l2.mCourseID = es2.mCourseID
                      AND (l2.stationID = 0 OR es2.stationID = 0 OR l2.stationID = es2.stationID)
                      AND l2.l2Status = 'Pass'
                  )
                )
                OR (
                  sc.subCourseLevel = 'Level 4'
                  AND EXISTS (
                    SELECT 1 FROM skillmatrix_station_skills sms
                    WHERE sms.uniqueID = es2.uniqueID
                      AND sms.deptID = es2.deptID
                      AND sms.areaID = es2.areaID
                      AND sms.mCourseID = es2.mCourseID
                      AND (sms.stationID = 0 OR es2.stationID = 0 OR sms.stationID = es2.stationID)
                      AND sms.requiredLevel >= 4
                  )
                  AND EXISTS (
                    SELECT 1 FROM l3completedusers l3
                    WHERE l3.uniqueID = es2.uniqueID
                      AND l3.mCourseID = es2.mCourseID
                      AND (l3.stationID = 0 OR es2.stationID = 0 OR l3.stationID = es2.stationID)
                      AND l3.l3Status = 'Pass'
                  )
                )
              )
          )

        UNION

        SELECT DISTINCT
          rsc.subCourseID AS courseID,
          rsc.subCourseName AS courseName,
          'Refresher' AS courseLevel,
          rsc.courseType,
          'refresher' AS source,
          COALESCE(
            (SELECT rcg.status FROM refresher_coursegrades rcg WHERE rcg.uniqueID = ? AND rcg.subCourseID = rsc.subCourseID ORDER BY rcg.id DESC LIMIT 1),
            (SELECT rtg.status FROM refresher_traininggrades rtg WHERE rtg.uniqueID = ? AND rtg.subCourseID = rsc.subCourseID ORDER BY rtg.id DESC LIMIT 1),
            'No Attempt'
          ) AS status,
          COALESCE(
            (SELECT rcg.score FROM refresher_coursegrades rcg WHERE rcg.uniqueID = ? AND rcg.subCourseID = rsc.subCourseID ORDER BY rcg.id DESC LIMIT 1),
            (SELECT rtg.score FROM refresher_traininggrades rtg WHERE rtg.uniqueID = ? AND rtg.subCourseID = rsc.subCourseID ORDER BY rtg.id DESC LIMIT 1)
          ) AS score
        FROM refresher_subcourses rsc
        WHERE EXISTS (
          SELECT 1
          FROM skillmatrix_refresher_assignments sra
          WHERE sra.uniqueID = ?
            AND sra.planMonth = MONTH(CURDATE())
            AND sra.planYear = YEAR(CURDATE())
            AND COALESCE(sra.planCode, 'RT') = 'RT'
            AND sra.status IN ('Planned', 'planned')
        )

        ORDER BY courseLevel, courseName
      `;

      connection.query(
        gradesQuery,
        [uniqueID, uniqueID, uniqueID, uniqueID, uniqueID, uniqueID, uniqueID, uniqueID, uniqueID, uniqueID, uniqueID, uniqueID, uniqueID, uniqueID, uniqueID, uniqueID, uniqueID, uniqueID, uniqueID, uniqueID],
        (gradesError, gradeRows) => {
          if (gradesError) {
            console.error('Error fetching grades:', gradesError);
            return res.status(500).json({ success: false, message: 'Internal Server Error' });
          }

          const grades = gradeRows.map((row, index) => ({
            courseIndex: index + 1,
            courseID: row.courseID,
            courseName: row.courseName,
            courseLevel: row.courseLevel,
            courseType: row.courseType,
            source: row.source || 'regular',
            status: row.status,
            // Keep `posttest` for compatibility with any existing callers that
            // expect that field name, in addition to the new `score`.
            posttest: row.score === null || row.score === undefined ? 'N/A' : row.score,
            score: row.score === null || row.score === undefined ? null : row.score
          }));

          console.log(`Returning grades for user ${uniqueID} with ${grades.length} courses`);

          res.json({ success: true, userDetails, grades });
        }
      );
    });

  } catch (error) {
    console.error('Error in getMyGrades route:', error);
    console.error('Stack trace:', error.stack);
    res.status(500).json({
      success: false,
      message: 'Internal Server Error',
      details: error.message
    });
  }
});


// Route for serving myProfile.html and fetching user details
app.get('/myProfile', (req, res) => {
  // Guard against a missing/expired session instead of throwing when
  // req.session.user is undefined (was crashing this route and silently
  // leaving the profile page blank on the frontend).
  if (!req.session || !req.session.user || !req.session.user.username) {
    return res.status(401).json({ success: false, message: 'Not logged in' });
  }
  const username = req.session.user.username;

  // Query to retrieve user data for the logged-in user only. This is a
  // read-only, view-your-own-profile page - no update route is wired to it.
  // NOTE: the users table has no `currentDate` column (that was the bug -
  // ER_BAD_FIELD_ERROR). `registerDate` is the actual column that holds when
  // the account was created; aliased back to currentDate so the existing
  // frontend field mapping doesn't need to change.
  const query = 'SELECT name, emailID, employeeID, uName, uPass, mobileNo, dateOfBirth, address, dateOfJoining, department, uRole, registerDate AS currentDate, photo FROM users WHERE uName = ?';

  connection.query(query, [username], (error, results) => {
    if (error) {
      console.error('Error retrieving user data:', error);
      return res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
    // Sending user data as JSON response
    res.json(results);
  });
});




// -------------------- BULK USER UPLOAD (Harman-style preview/validation) --------------------

// Normalize a sheet row -> our user fields (accepts flexible/case-insensitive headers)
function normalizeBulkUserRow(obj) {
  const pick = (keys) => {
    for (const k of keys) {
      if (obj[k] != null && String(obj[k]).trim() !== '') return String(obj[k]).trim();
      const found = Object.keys(obj).find(x => x.toLowerCase() === k.toLowerCase());
      if (found && String(obj[found]).trim() !== '') return String(obj[found]).trim();
    }
    return '';
  };

  return {
    name: pick(['name', 'full name', 'fullname']),
    emailID: pick(['email', 'emailid', 'email id']),
    employeeID: pick(['employeeid', 'employee id', 'empid', 'emp id']),
    uName: pick(['uname', 'username', 'user name', 'login', 'login id']),
    uPass: pick(['upass', 'password', 'pass']),
    dateOfJoining: pick(['dateofjoining', 'date of joining', 'doj']),
    dateOfBirth: pick(['dateofbirth', 'date of birth', 'dob']),
    address: pick(['address']),
    mobileNo: pick(['mobileno', 'mobile no', 'mobile', 'phone']),
    department: pick(['department', 'dept']),
    uRole: pick(['urole', 'role']),
    qualification: pick(['qualification']),
    contract: pick(['contract']),
    userTags: pick(['usertags', 'course tags', 'coursetags', 'tags', 'level'])
  };
}

const BULK_USER_FIELD_ORDER = [
  'name', 'emailID', 'employeeID', 'uName', 'uPass',
  'dateOfJoining', 'dateOfBirth', 'address', 'mobileNo',
  'department', 'uRole', 'qualification', 'contract', 'userTags'
];

// PREVIEW: parse the sheet, validate, flag duplicates, send rows + stats back to the client
app.post('/upload-bulk-users', upload.single('bulkUsersFile'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded.' });

    const workbook = xlsx.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const raw = xlsx.utils.sheet_to_json(sheet, { defval: '' });

    const rows = raw.map((r, idx) => {
      const n = normalizeBulkUserRow(r);
      if (!n.uRole) n.uRole = 'Employee';
      return { idx: idx + 1, ...n };
    });

    // Stage 1: required fields — every Mahindra learner needs a working uName/uPass login
    rows.forEach(r => {
      r.invalid = (!r.name || !r.uName || !r.uPass);
      r.reasonInvalid = r.invalid ? 'Missing required (name/uName/uPass)' : '';
    });

    // Stage 2: duplicate uName within the sheet itself
    const seen = new Map();
    rows.forEach(r => {
      if (!r.uName) return;
      if (seen.has(r.uName)) {
        r.duplicateInSheet = true;
        r.reasonSheet = 'Duplicate uName in sheet';
        const first = seen.get(r.uName);
        first.duplicateInSheet = true;
        if (!first.reasonSheet) first.reasonSheet = 'Duplicate uName in sheet';
      } else {
        seen.set(r.uName, r);
      }
    });

    // Stage 3: duplicate against existing DB rows (by uName, or by name+uName pair)
    const uNames = rows.map(r => r.uName).filter(Boolean);
    const names = rows.map(r => r.name).filter(Boolean);

    let dbConflicts = { byUName: new Set(), byPair: new Set() };
    if (uNames.length || names.length) {
      let sql = 'SELECT name, uName FROM users WHERE 1=0';
      const params = [];
      if (uNames.length) { sql += ` OR uName IN (${uNames.map(() => '?').join(',')})`; params.push(...uNames); }
      if (names.length) { sql += ` OR name IN (${names.map(() => '?').join(',')})`; params.push(...names); }
      const [existing] = await connection.promise().query(sql, params);

      dbConflicts.byUName = new Set(existing.map(r => String(r.uName)));
      dbConflicts.byPair = new Set(existing.map(r => `${String(r.name)}||${String(r.uName)}`));
    }

    rows.forEach(r => {
      const pairKey = `${r.name}||${r.uName}`;
      const dupU = dbConflicts.byUName.has(r.uName);
      const dupPair = dbConflicts.byPair.has(pairKey);
      if (dupU || dupPair) {
        r.duplicateInDB = true;
        r.reasonDB = dupU ? 'uName exists in DB' : 'name+uName exists in DB';
      }
    });

    rows.forEach(r => {
      r.isBlocked = !!(r.invalid || r.duplicateInSheet || r.duplicateInDB);
      r.blockReason = [r.reasonInvalid, r.reasonSheet, r.reasonDB].filter(Boolean).join('; ');
    });

    const presentColumns = BULK_USER_FIELD_ORDER.filter(k =>
      rows.some(r => (r[k] ?? '').toString().trim() !== '')
    );
    ['name', 'uName', 'uPass'].forEach(reqKey => {
      if (!presentColumns.includes(reqKey)) presentColumns.unshift(reqKey);
    });

    const stats = {
      total: rows.length,
      invalid: rows.filter(r => r.invalid).length,
      duplicatesInSheet: rows.filter(r => r.duplicateInSheet).length,
      duplicatesInDB: rows.filter(r => r.duplicateInDB).length,
      insertable: rows.filter(r => !r.isBlocked).length
    };

    return res.json({
      success: true,
      preview: rows,
      stats,
      presentColumns,
      dbUNameList: Array.from(dbConflicts.byUName),
      dbPairList: Array.from(dbConflicts.byPair)
    });
  } catch (err) {
    console.error('Bulk preview error:', err);
    return res.status(500).json({ success: false, message: 'Failed to process bulk file' });
  }
});

// CONFIRM: re-validate against fresh DB state, then insert only the non-blocked rows
app.post('/confirm-bulk-users', express.json({ limit: '50mb' }), async (req, res) => {
  try {
    const items = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!items.length) return res.status(400).json({ success: false, message: 'No rows to insert' });

    const v = (x) => (x == null ? '' : String(x).trim());

    const uNames = items.map(r => v(r.uName)).filter(Boolean);
    let existingByU = new Set();
    if (uNames.length) {
      const [ex] = await connection.promise().query(
        `SELECT uName FROM users WHERE uName IN (${uNames.map(() => '?').join(',')})`,
        uNames
      );
      existingByU = new Set(ex.map(r => String(r.uName)));
    }

    const myCurrentDate = new Date().toLocaleDateString('en-GB', {});
    const myCurrentTime = new Date().toLocaleTimeString('en-US', {});

    const toInsert = [];
    for (const r of items) {
      const name = v(r.name);
      const uName = v(r.uName);
      const uPass = v(r.uPass);
      if (!name || !uName || !uPass) continue;       // learner login is mandatory
      if (existingByU.has(uName)) continue;          // guard against race conditions

      toInsert.push([
        name, v(r.emailID), v(r.employeeID), uName, uPass,
        v(r.dateOfJoining) || null, v(r.dateOfBirth) || null,
        v(r.address), v(r.mobileNo), v(r.department), v(r.uRole) || 'Employee',
        'default.png', '/photos/default.png',
        myCurrentDate, myCurrentTime,
        v(r.qualification), v(r.contract), v(r.userTags)
      ]);
    }

    if (!toInsert.length) return res.json({ success: true, inserted: 0 });

    const sql = `
      INSERT INTO users
        (name, emailID, employeeID, uName, uPass, dateOfJoining, dateOfBirth, address, mobileNo,
         department, uRole, photo, photoPath, registerDate, registerTime, qualification, contract, userTags)
      VALUES ?
    `;

    try {
      await connection.promise().query(sql, [toInsert]);
    } catch (bulkErr) {
      console.error('Bulk insert failed, falling back to per-row insert:', bulkErr);
      const rowSql = sql.replace('VALUES ?', `VALUES (${toInsert[0].map(() => '?').join(',')})`);
      for (const row of toInsert) {
        await connection.promise().query(rowSql, row);
      }
    }

    return res.json({ success: true, inserted: toInsert.length });
  } catch (err) {
    console.error('Bulk confirm error:', err);
    return res.status(500).json({ success: false, message: 'Failed to insert bulk users' });
  }
});


// // Route to handle saving changes
/*app.post('/saveChanges', (req, res) => {
  const updatedData = req.body;
 
  // Loop through updated data and update corresponding records in the database
  updatedData.forEach(data => {
    // Construct the column name based on the courseID
    const mysqlColumnName  = `uCourse${data.courseID}`;
    // Assuming you have a function to update the database
    updateDatabase(data.employeeID, data.columnName, mysqlColumnName , data.newValue);
  });
 
  // Send response
  res.sendStatus(200);
});*/







//this router for the save updating grades from the gradesmanagement 24-04-2025  with employeeID
/*app.post('/saveChanges', async (req, res) => {
    const updates = req.body.updatedData;
 
    if (!Array.isArray(updates) || updates.length === 0) {
        return res.status(400).json({ error: 'No data received' });
    }
 
    const connectionPromise = connection.promise();
    const updateTasks = [];
 
    try {
        for (const entry of updates) {
            const { employeeID, columnName, newValue, courseName } = entry;
 
            if (!employeeID || !columnName) continue;
 
            // Update the Posttest score (or other field)
            const query = `UPDATE users SET \`${columnName}\` = ? WHERE employeeID = ?`;
            updateTasks.push(connectionPromise.query(query, [newValue, employeeID]));
 
            // If the column is like "course3Posttest", update "uCourse3"
            const match = columnName.match(/^course(\d+)Posttest$/);
            if (match && courseName) {
                const courseNumber = match[1];
                const uCourseColumn = `uCourse${courseNumber}`;
 
                const updateUCourse = connectionPromise.query(
                    `UPDATE users SET \`${uCourseColumn}\` = ? WHERE employeeID = ?`,
                    [courseName, employeeID]
                );
                updateTasks.push(updateUCourse);
            }
        }
 
        await Promise.all(updateTasks);
        res.status(200).json({ success: true, updated: updateTasks.length });
    } catch (error) {
        console.error('Batch update failed:', error);
        res.status(500).json({ success: false, message: 'Database error' });
    }
});*/




//this router for the save updating grades from the gradesmanagement 24-04-2025  with uniqueID

/*app.post('/saveChanges', async (req, res) => {
    const updates = req.body.updatedData;
 
    if (!Array.isArray(updates) || updates.length === 0) {
        return res.status(400).json({ error: 'No data received' });
    }
 
    const connectionPromise = connection.promise();
    const updateTasks = [];
 
    try {
        for (const entry of updates) {
            const { uniqueID, columnName, newValue, courseName } = entry;
 
            if (!uniqueID || !columnName) continue;
 
            // Update Posttest score
            const updateScoreQuery = `UPDATE users SET \`${columnName}\` = ? WHERE uniqueID = ?`;
            updateTasks.push(connectionPromise.query(updateScoreQuery, [newValue, uniqueID]));
 
            // Optionally update uCourseX column if courseName is provided
            const match = columnName.match(/^course(\d+)Posttest$/);
            if (match && courseName) {
                const courseNumber = match[1];
                const uCourseColumn = `uCourse${courseNumber}`;
 
                const updateUCourseQuery = `UPDATE users SET \`${uCourseColumn}\` = ? WHERE uniqueID = ?`;
                updateTasks.push(connectionPromise.query(updateUCourseQuery, [courseName, uniqueID]));
            }
        }
 
        await Promise.all(updateTasks);
        res.status(200).json({ success: true, updated: updateTasks.length });
    } catch (error) {
        console.error('Batch update failed:', error);
        res.status(500).json({ success: false, message: 'Database error' });
    }
});*/





function getFormattedDateTimeIST() {
  const now = new Date();
  const istNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));

  const yyyy = istNow.getFullYear();
  const mm = String(istNow.getMonth() + 1).padStart(2, '0');
  const dd = String(istNow.getDate()).padStart(2, '0');
  const hh = String(istNow.getHours()).padStart(2, '0');
  const min = String(istNow.getMinutes()).padStart(2, '0');
  const ss = String(istNow.getSeconds()).padStart(2, '0');

  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
}


app.post('/saveChanges', async (req, res) => {
  const updates = req.body.updatedData;

  if (!Array.isArray(updates) || updates.length === 0) {
    return res.status(400).json({ error: 'No data received' });
  }

  const connectionPromise = connection.promise();
  const updateTasks = [];

  try {
    for (const entry of updates) {
      const { uniqueID, columnName, newValue, oldValue, courseName } = entry;

      if (!uniqueID || !columnName) continue;

      // ✅ Only update if the value actually changed
      if (newValue === oldValue) continue;

      const match = columnName.match(/^course(\d+)Posttest$/);
      if (!match) continue;

      const courseNumber = match[1];

      // Update posttest score
      const updateScoreQuery = `UPDATE users SET \`${columnName}\` = ? WHERE uniqueID = ?`;
      updateTasks.push(connectionPromise.query(updateScoreQuery, [newValue, uniqueID]));

      // Update course name if provided
      if (courseName) {
        const uCourseColumn = `uCourse${courseNumber}`;
        const updateUCourseQuery = `UPDATE users SET \`${uCourseColumn}\` = ? WHERE uniqueID = ?`;
        updateTasks.push(connectionPromise.query(updateUCourseQuery, [courseName, uniqueID]));
      }

      // ✅ Update only that course's TrainDate
      const trainDateColumn = `course${courseNumber}TrainDate`;
      const trainDate = getFormattedDateTimeIST();
      const updateTrainDateQuery = `UPDATE users SET \`${trainDateColumn}\` = ? WHERE uniqueID = ?`;
      updateTasks.push(connectionPromise.query(updateTrainDateQuery, [trainDate, uniqueID]));
    }

    await Promise.all(updateTasks);
    res.status(200).json({ success: true, updated: updateTasks.length });
  } catch (error) {
    console.error('Batch update failed:', error);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});










function updateDatabase(employeeID, columnName, newValue) {
  const query = `UPDATE users SET ${columnName} = ? WHERE employeeID = ?`;
  connection.query(query, [newValue, employeeID], (error, results) => {
    if (error) {
      console.error('Error updating database:', error);
    } else {
      console.log('Database updated successfully');
    }
  });
}


// Route to handle saving changes
/*
app.post('/saveChanges', (req, res) => {
  const { updatedData } = req.body;
 
  // Loop through updated data and update corresponding records in the database
  // updatedData.forEach(data => {
  //   // Construct the column name based on the courseID
  //   //const mysqlColumnName = `uCourse${data.courseID}`;
  //   // Assuming you have a function to update the database
  //   updateDatabase(data.employeeID, data.columnName, data.newValue, data.courseName);
  // });
 
  updateDatabase(updatedData);
  // Send response
  res.sendStatus(200);
});
 
*/

function updateDatabase(updatedData) {
  updatedData.forEach(data => {
    // Check if columnName is defined before using startsWith
    if (data.columnName && data.columnName.startsWith('course')) {
      const courseNumber = data.columnName.match(/\d+/)[0];
      const uCourseColumnName = `uCourse${courseNumber}`;
      const query = `UPDATE users SET ${data.columnName} = ?, ${uCourseColumnName} = ? WHERE employeeID = ?`;
      connection.query(query, [data.newValue, data.courseName, data.employeeID], (error, results) => {
        if (error) {
          console.error('Error updating database:', error);
        } else {
          console.log('Database updated successfully');
        }
      });
    } else {
      const query = `UPDATE users SET ${data.columnName} = ? WHERE employeeID = ?`;
      connection.query(query, [data.newValue, data.employeeID], (error, results) => {
        if (error) {
          console.error('Error updating database:', error);
        } else {
          console.log('Database updated successfully');
        }
      });
    }
  });
}


// function updateDatabase(employeeID, columnName, newValue, courseName) {
//   const query = `UPDATE users SET ${columnName} = ?, uCourseName = ? WHERE employeeID = ?`;
//   connection.query(query, [newValue, courseName, employeeID], (error, results) => {
//     if (error) {
//       console.error('Error updating database:', error);
//     } else {
//       console.log('Database updated successfully');
//     }
//   });
// }



// NOTE: dead route removed - see comment near the old /gradesManagement
// route above. This queried a `courses` table that no longer exists
// (ER_NO_SUCH_TABLE) and was only ever called from the disconnected
// public/gradesManagement.html legacy page.



// This is for User Management page



// Route to handle saving changes
app.post('/userDetailsSaveChanges', (req, res) => {
  const updatedUserData = req.body;
  let allPromises = [];

  updatedUserData.forEach(data => {
    if (!data.columnName) {
      console.warn("Skipping update because columnName is missing:", data);
      return; // skip invalid entries
    }

    allPromises.push(new Promise((resolve, reject) => {
      const query = `UPDATE users SET ${data.columnName} = ? WHERE uniqueID = ?`;
      connection.query(query, [data.newValue, data.uniqueID], (error, results) => {
        if (error) {
          console.error('Error updating user database:', error);
          reject(error);
        } else {
          console.log('User Database updated successfully');
          resolve(results);
        }
      });
    }));
  });

  Promise.all(allPromises)
    .then(() => {
      res.sendStatus(200);
    })
    .catch((error) => {
      res.status(500).send('Error updating user database');
    });
});


function updateUserDatabase(uniqueID, newValue) {
  const query = `UPDATE users SET ${columnName} = ?, WHERE uniqueID = ?`;
  connection.query(query, [newValue, uniqueID], (error, results) => {
    if (error) {
      console.error('Error updating user database:', error);
    } else {
      console.log('User Database updated successfully');
    }
  });
}




// // Route to handle Excel file upload and process MCQs
// app.post("/uploadExcel", uploadExcelAss.single("mcqFile"), (req, res) => {
//   let { courseID, courseName, courseDescription, courseDate, courseTags } = req.body;
//   const filePath = req.file.path;

//   const uploadPath = 'Excel Assessment';

//   // Read the uploaded Excel file
//   const workbook = xlsx.readFile(filePath);
//   const sheetName = workbook.SheetNames[0];
//   const worksheet = workbook.Sheets[sheetName];

//   // Parse the worksheet data into JSON
//   const jsonData = xlsx.utils.sheet_to_json(worksheet);

//   // Set courseTags to "default" if it is not provided
//   if (!courseTags || courseTags.trim() === '') {
//     courseTags = 'default';
//   }

//   // Generate HTML content for MCQs
//   let htmlContent = `
//     <h1>${courseName} (Course ID: ${courseID})</h1>
//     <form id="quiz-form">
//   `;

//   // Insert course data into the courses table
//   const query = `INSERT INTO courses (courseName, courseDescription, courseDate, scormPath, courseID, courseTags) VALUES (?, ?, ?, ?, ?, ?)`;
//   connection.query(query, [courseName, courseDescription, courseDate, uploadPath, courseID, courseTags], (error, results) => {
//     if (error) {
//       console.error('Error saving course data:', error);
//       return res.status(500).send('Internal Server Error');
//     }
//     console.log('Course data saved successfully');

//     // Dynamically create column definitions
//     let columnDefinitions = `
//       id INT AUTO_INCREMENT PRIMARY KEY,
//       uniqueID VARCHAR(255) NOT NULL,
//       employeeID TEXT,
//       name TEXT,
//       noOfAttempts INT DEFAULT 0
//     `;

//     for (let i = 1; i <= 35; i++) {
//       columnDefinitions += `,
//         course_${courseID}_Posttest${i} LONGTEXT,
//         score${i} LONGTEXT,
//         status${i} LONGTEXT,
//         duration${i} LONGTEXT
//       `;
//     }

//     const createTableQuery = `CREATE TABLE IF NOT EXISTS course_${courseID} (${columnDefinitions});`;


//     connection.query(createTableQuery, (err) => {
//       if (err) {
//         console.error('Error creating course table:', err);
//         return res.status(500).send('Error creating course table');
//       }
//       console.log(`Table course_${courseID} created successfully`);

//       // Query the users table to get uniqueID, employeeID, and name
//       const selectUsersQuery = `SELECT uniqueID, employeeID, name FROM users`;

//       connection.query(selectUsersQuery, (err, users) => {
//         if (err) {
//           console.error('Error fetching users data:', err);
//           return res.status(500).send('Error fetching users data');
//         }

//         // Insert data into course_${courseID} table
//         const insertUserData = `INSERT INTO course_${courseID} (uniqueID, employeeID, name) VALUES ?`;
//         const userData = users.map(user => [user.uniqueID, user.employeeID, user.name]);

//         connection.query(insertUserData, [userData], (err) => {
//           if (err) {
//             console.error('Error inserting user data:', err);
//             return res.status(500).send('Error inserting user data');
//           }
//           console.log(`User data inserted into course_${courseID} successfully`);

//           // Send JavaScript response to show alert message and redirect back to the upload page
//           const script = `
//             <script>
//               const uploadConfirmation = confirm('Course uploaded, table created, and user data inserted successfully. Click OK to return to the upload page.');
//               if (uploadConfirmation) {
//                   window.location.href = '/'; // Redirect to the upload page
//               }
//             </script>
//           `;
//           jsonData.forEach((row, index) => {
//             htmlContent += `
//               <div class="question">
//                 <p><strong>${index + 1}. ${row.questionText}</strong></p>
//                 <label><input type="radio" name="question${index}" value="${row.option1Text}"> ${row.option1Text}</label><br>
//                 <label><input type="radio" name="question${index}" value="${row.option2Text}"> ${row.option2Text}</label><br>
//                 <label><input type="radio" name="question${index}" value="${row.option3Text}"> ${row.option3Text}</label><br>
//                 <label><input type="radio" name="question${index}" value="${row.option4Text}"> ${row.option4Text}</label><br>
//               </div>
//             `;
//           });

//           htmlContent += `<button type="submit">Submit</button></form>`;

//           // Save HTML file
//           const htmlFilePath = path.join(__dirname, "Excel Assessment", "Assessment pages", `${courseID}_quiz.html`);
//           fs.writeFileSync(htmlFilePath, htmlContent);

//           // Respond with success and reload the page
//           res.send(`
//             <p>File uploaded and quiz generated successfully!</p>
//             <a href="/">Upload another file</a> | 
//             <a href="/quiz/${courseID}">View Quiz</a>
//           `);
//           res.send(script);
//         });
//       });
//     });
//   });


// });

// Route to handle Excel file upload and process MCQs
/*app.post("/uploadExcel", uploadExcelAss.single("mcqFile"), (req, res) => {
  let { courseID, courseName, courseDescription, courseDate, courseTags } = req.body;
  const filePath = req.file.path;
 
  const uploadPath = 'Excel Assessment';
 
  // Read the uploaded Excel file
  const workbook = xlsx.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
 
  // Parse the worksheet data into JSON
  const jsonData = xlsx.utils.sheet_to_json(worksheet);
 
  // Set courseTags to "default" if it is not provided
  if (!courseTags || courseTags.trim() === '') {
    courseTags = 'default';
  }
 
  // Generate HTML content for MCQs
  let htmlContent = `
    <h1>${courseName} (Course ID: ${courseID})</h1>
    <form id="quiz-form">
  `;
 
  // Insert course data into the courses table
  const query = `INSERT INTO courses (courseName, courseDescription, courseDate, scormPath, courseID, courseTags) VALUES (?, ?, ?, ?, ?, ?)`;
  connection.query(query, [courseName, courseDescription, courseDate, uploadPath, courseID, courseTags], (error, results) => {
    if (error) {
      console.error('Error saving course data:', error);
      return res.status(500).send('Internal Server Error');
    }
    console.log('Course data saved successfully');
 
    // Dynamically create column definitions
    let columnDefinitions = `
      id INT AUTO_INCREMENT PRIMARY KEY,
      uniqueID VARCHAR(255) NOT NULL,
      employeeID TEXT,
      name TEXT,
      noOfAttempts INT DEFAULT 0
    `;
 
    for (let i = 1; i <= 35; i++) {
      columnDefinitions += `,
        course_${courseID}_Posttest${i} LONGTEXT,
        score${i} LONGTEXT,
        status${i} LONGTEXT,
        duration${i} LONGTEXT
      `;
    }
 
    const createTableQuery = `CREATE TABLE IF NOT EXISTS course_${courseID} (${columnDefinitions});`;
 
    connection.query(createTableQuery, (err) => {
      if (err) {
        console.error('Error creating course table:', err);
        return res.status(500).send('Error creating course table');
      }
      console.log(`Table course_${courseID} created successfully`);
 
      // Query the users table to get uniqueID, employeeID, and name
      const selectUsersQuery = `SELECT uniqueID, employeeID, name FROM users`;
 
      connection.query(selectUsersQuery, (err, users) => {
        if (err) {
          console.error('Error fetching users data:', err);
          return res.status(500).send('Error fetching users data');
        }
 
        // Insert data into course_${courseID} table
        const insertUserData = `INSERT INTO course_${courseID} (uniqueID, employeeID, name) VALUES ?`;
        const userData = users.map(user => [user.uniqueID, user.employeeID, user.name]);
 
        connection.query(insertUserData, [userData], (err) => {
          if (err) {
            console.error('Error inserting user data:', err);
            return res.status(500).send('Error inserting user data');
          }
          console.log(`User data inserted into course_${courseID} successfully`);
 
          // Generate HTML for each question in jsonData
          jsonData.forEach((row, index) => {
            htmlContent += `
              <div class="question">
                <p><strong>${index + 1}. ${row.questionText}</strong></p>
                <label><input type="radio" name="question${index}" value="${row.option1Text}"> ${row.option1Text}</label><br>
                <label><input type="radio" name="question${index}" value="${row.option2Text}"> ${row.option2Text}</label><br>
                <label><input type="radio" name="question${index}" value="${row.option3Text}"> ${row.option3Text}</label><br>
                <label><input type="radio" name="question${index}" value="${row.option4Text}"> ${row.option4Text}</label><br>
              </div>
            `;
          });
 
          htmlContent += `<button type="submit">Submit</button></form>`;
 
          // Save HTML file
          const htmlFilePath = path.join(__dirname, "Excel Assessment", "Assessment pages", `${courseID}_quiz.html`);
          fs.writeFileSync(htmlFilePath, htmlContent);
 
          // Send final response with HTML and JavaScript combined
          res.send(`
            <p>File uploaded and quiz generated successfully!</p>
            <a href="/">Upload another file</a> | 
            <a href="/quiz/${courseID}">View Quiz</a>
            <script>
              const uploadConfirmation = confirm('Course uploaded, table created, and user data inserted successfully. Click OK to return to the upload page.');
              if (uploadConfirmation) {
                  // <p>File uploaded and quiz generated successfully!</p>
                  // <a href="/createCourse">Upload another file</a> | 
                  // <a href="/quiz/${courseID}">View Quiz</a>
                  window.location.href = '/createCourse.html';
              }
            </script>
          `);
        });
      });
    });
  });
});*/


//BHIMASHANKAR


app.post("/uploadExcel", uploadFiles, (req, res) => {
  console.log("Files received:", req.files);
  console.log("Body received:", req.body);

  let { courseID, courseName, courseDescription, courseDate, level, mCourseName, RT_Date } = req.body;
  // Level 1 Management flow (see public/uploadExcelAssessment.html) - same
  // standalone/no-hierarchy handling as /uploadTrainingMaterial.
  const isLevel1 = String(req.body.level1 || '').trim() === '1';
  const isRefresher = String(req.body.refresher || '').trim() === '1';
  // Common Level 2/3/4 course: same standalone/no-hierarchy handling as Level 1,
  // but keeps whatever Level (2/3/4) the admin chose instead of forcing Level 1.
  const isCommon = String(req.body.isCommon || '').trim() === '1';
  if (!courseID) {
    courseID = Date.now();
  }

  const assessmentVariants = [1,2,3].map(slot => {
    const mcqFile = req.files[`mcqFile${slot}`]?.[0];
    const supportFile = req.files[`supportFile${slot}`]?.[0];
    const language = String(req.body[`language${slot}`] || '').trim();
    return mcqFile && supportFile && language
      ? { mcqFile, supportFile, language: safeTrainingLanguageFolder(language) } : null;
  }).filter(Boolean);
  // Backward compatibility with the earlier single-language form.
  const legacyMcq = req.files.mcqFile?.[0];
  const legacySupport = req.files.videoFile?.[0] || req.files.pptFile?.[0];
  if (!assessmentVariants.length && legacyMcq) {
    assessmentVariants.push({ mcqFile: legacyMcq, supportFile: legacySupport || null, language: 'English' });
  }
  const mcqFile = assessmentVariants[0]?.mcqFile;
  const primarySupport = assessmentVariants[0]?.supportFile;
  const primarySupportExt = path.extname(primarySupport?.originalname || '').toLowerCase();
  const videoFile = primarySupport && ['.mp4','.webm','.ogg','.mov','.m4v'].includes(primarySupportExt) ? primarySupport : null;
  const pptFile = primarySupport && !videoFile ? primarySupport : null;

  if (!mcqFile) {
    return res.status(400).send("MCQ file is missing!");
  }

  // --- NEW: Dynamic Folder Creation and Path Definition ---
  const courseFolder = `${courseID}_course`;
  const baseUploadDir = path.join(__dirname, "uploads", "Training Assessment", "Posttest assessment");
  const courseRootPath = path.join(baseUploadDir, courseFolder);
  const coursePath = path.join(courseRootPath, assessmentVariants[0].language);

  // Ensure the course-specific folder exists
  if (!fs.existsSync(courseRootPath)) {
    fs.mkdirSync(courseRootPath, { recursive: true });
    console.log(`Course directory created at: ${coursePath}`);
  }
  fs.mkdirSync(coursePath, { recursive: true });

  // Define new file paths within the dynamic folder
  const mcqFilePath = path.join(coursePath, `${Date.now()}_${mcqFile.originalname}`);

  // Make video file path OPTIONAL and SAFE
  const videoFilePath = videoFile
    ? path.join(coursePath, `${courseID}_video.mp4`)
    : null;
  const pptFilePath = pptFile
    ? path.join(coursePath, `${courseID}_${path.basename(pptFile.originalname)}`)
    : null;

  try {
    // Save MCQ file
    fs.writeFileSync(mcqFilePath, mcqFile.buffer);
    console.log(`MCQ file saved at: ${mcqFilePath}`);

    if (!fs.existsSync(mcqFilePath)) {
      throw new Error("MCQ file path is invalid!");
    }

    // OPTIONAL: Save video file ONLY if uploaded
    if (videoFile && videoFilePath) {
      fs.writeFileSync(videoFilePath, videoFile.buffer);
      console.log(`Video file saved at: ${videoFilePath}`);
    } else if (pptFile && pptFilePath) {
      fs.writeFileSync(pptFilePath, pptFile.buffer);
      console.log(`PPT file saved at: ${pptFilePath}`);
    } else {
      console.log("No extra assessment media uploaded. Skipping media save.");
    }

    // Read Excel File
    const workbook = xlsx.readFile(mcqFilePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];

    const jsonData = xlsx.utils.sheet_to_json(worksheet);
    assessmentVariants[0].jsonData = jsonData;
    assessmentVariants[0].uploadPath = `uploads/Training Assessment/Posttest assessment/${courseFolder}/${assessmentVariants[0].language}`;
    assessmentVariants[0].supportFileName = videoFile
      ? `${courseID}_video.mp4`
      : (pptFile ? `${courseID}_${path.basename(pptFile.originalname)}` : null);

    for (const variant of assessmentVariants.slice(1)) {
      const languagePath = path.join(courseRootPath, variant.language);
      fs.mkdirSync(languagePath, { recursive: true });
      const excelName = `${Date.now()}_${path.basename(variant.mcqFile.originalname)}`;
      const supportName = `${courseID}_${path.basename(variant.supportFile.originalname)}`;
      const excelPath = path.join(languagePath, excelName);
      fs.writeFileSync(excelPath, variant.mcqFile.buffer);
      fs.writeFileSync(path.join(languagePath, supportName), variant.supportFile.buffer);
      const variantWorkbook = xlsx.readFile(excelPath);
      variant.jsonData = xlsx.utils.sheet_to_json(variantWorkbook.Sheets[variantWorkbook.SheetNames[0]]);
      variant.supportFileName = supportName;
      variant.uploadPath = `uploads/Training Assessment/Posttest assessment/${courseFolder}/${variant.language}`;
    }

    if (isLevel1) {
      level = 'Level 1';
    } else if (isRefresher) {
      level = 'Refresher';
    } else if (!level || level.trim() === '') {
      level = 'default';
    }

    const refreshalMonths = RT_Date;
    RT_Date = calculateRefreshalDate(courseDate, refreshalMonths);

    if (RT_Date) {
      console.log(`Calculated RT_Date: ${RT_Date} (${refreshalMonths} months from ${courseDate})`);
    }

    // Load HTML Template
    const templatePath = path.join(__dirname, "public", "trainingAss_Template.html");
    let template = fs.readFileSync(templatePath, "utf-8");

    // SCORM Path still same
    const uploadPath = `uploads/Training Assessment/Posttest assessment/${courseFolder}/${assessmentVariants[0].language}`;

    if (isRefresher) {
      insertRefresherSubcourseFromUpload(
        { ...req.body, courseID, courseName, courseDescription, courseDate, level, RT_Date: refreshalMonths },
        uploadPath,
        'assessment',
        pptFile ? 'excel_with_ppt' : (videoFile ? 'video_with_excel' : 'excel'),
        (refresherError, refresherResult) => {
          if (refresherError) {
            console.error('Error saving refresher Excel assessment:', refresherError);
            return res.status(500).send(refresherError.message || 'Error saving refresher course');
          }
          generateQuizAndRespond(refresherResult.insertId, '/refresherCourses.html');
        }
      );
      return;
    }

    insertNormalizedSubcourseFromUpload(
      { ...req.body, courseID, courseName, courseDescription, courseDate, level, mCourseName, RT_Date: refreshalMonths, skipHierarchy: isLevel1, isCommon },
      uploadPath,
      'assessment',
      pptFile ? 'excel_with_ppt' : (videoFile ? 'video_with_excel' : 'excel'),
      (normalizedError, normalizedResult, usedNormalizedSchema) => {
        if (normalizedError && !shouldFallbackToLegacySchema(normalizedError)) {
          console.error('Error saving normalized Excel assessment:', normalizedError);
          return res.status(500).send(normalizedError.message || 'Error saving normalized course');
        }

        if (!usedNormalizedSchema) {
          continueLegacyExcelUpload();
          return;
        }

        const postUploadRedirect = isLevel1
          ? '/l1Courses.html'
          : isCommon
            ? `/commonCourses.html?level=${encodeURIComponent(level || '')}`
            : `/l2Courses.html?mCourseID=${encodeURIComponent(req.body.mCourseID || '')}&stationID=${encodeURIComponent(req.body.stationID || '')}`;
        generateQuizAndRespond(normalizedResult.insertId, postUploadRedirect);
      }
    );

    function generateQuizAndRespond(savedCourseID, redirectUrl) {
      assessmentVariants.forEach((variant, variantIndex) => {
      let quizQuestions = "";

      variant.jsonData.forEach((row, index) => {
        const answerKey = {
          'A': row.option1Text,
          'B': row.option2Text,
          'C': row.option3Text,
          'D': row.option4Text
        };

        const correctAnswerText = answerKey[String(row.answerText).trim().toUpperCase()];

        const escapeAttr = (text) => String(text).replace(/"/g, '&quot;');
        const escapeHTML = (text) => String(text);

        quizQuestions += `
          <div class="question" data-question-number="${index + 1}" data-correct-answer="${escapeAttr(correctAnswerText)}">
              <p><strong>${index + 1}. ${escapeHTML(row.questionText)}</strong></p>
              <label><input type="radio" name="question${index}" value="${escapeAttr(row.option1Text)}"> ${escapeHTML(row.option1Text)}</label><br>
              <label><input type="radio" name="question${index}" value="${escapeAttr(row.option2Text)}"> ${escapeHTML(row.option2Text)}</label><br>
              <label><input type="radio" name="question${index}" value="${escapeAttr(row.option3Text)}"> ${escapeHTML(row.option3Text)}</label><br>
              <label><input type="radio" name="question${index}" value="${escapeAttr(row.option4Text)}"> ${escapeHTML(row.option4Text)}</label><br>
          </div>
        `;
      });

      const finalQuizHTML = template
        .replace(/{{courseName}}/g, courseName)
        .replace(/{{courseID}}/g, savedCourseID)
        .replace(/{{trainingMedia}}/g, buildAssessmentMediaHTML(variant))
        .replace(/{{quizQuestions}}/g, quizQuestions);

      const htmlFilePath = path.join(courseRootPath, variant.language, `${savedCourseID}_quiz.html`);
      fs.writeFileSync(htmlFilePath, finalQuizHTML);
      if (variantIndex === 0) persistSubcourseQuestions(savedCourseID, variant.jsonData);
      });

      saveTrainingLanguageRows(savedCourseID, isRefresher ? 'refresher' : 'regular', assessmentVariants, 'assessment', error => {
        if (error) console.error('Error registering assessment languages:', error);
      });

      res.send(`
        <p>File uploaded and quiz generated successfully!</p>
        <a href="/training/${savedCourseID}">View Quiz</a>
        <script>
            const uploadConfirmation = confirm('Course uploaded successfully.');
            if (uploadConfirmation) {
                window.location.href = '${redirectUrl}';
            }
        </script>
      `);
    }

    function buildAssessmentMediaHTML(variant) {
      if (!variant.supportFileName) return '<p>No supporting training material uploaded.</p>';
      const src = `/${variant.uploadPath}/${variant.supportFileName}`;
      const ext = path.extname(variant.supportFileName).toLowerCase();
      if (['.mp4','.webm','.ogg','.mov','.m4v'].includes(ext)) {
        return `<video controls style="width:100%;max-height:62vh"><source src="${src}">Your browser does not support this video.</video>`;
      }
      return `<iframe src="${src}" style="width:100%;height:62vh;border:1px solid #ccd5df"></iframe>`;
    }

    function continueLegacyExcelUpload() {
      const query = `INSERT INTO courses 
        (courseName, courseDescription, courseDate, scormPath, courseID, level, mCourseName, RT_Date) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

      connection.query(
        query,
        [courseName, courseDescription, courseDate, uploadPath, courseID, level, mCourseName, RT_Date],
        (error) => {
          if (error) {
            console.error('Error saving course data:', error);
            return res.status(500).send('Internal Server Error');
          }
          console.log('Course data saved successfully');

          let columnDefinitions = `
            id INT AUTO_INCREMENT PRIMARY KEY,
            uniqueID VARCHAR(255) NOT NULL,
            employeeID TEXT,
            name TEXT,
            noOfAttempts INT DEFAULT 0
          `;

          for (let i = 1; i <= 27; i++) {
            columnDefinitions += `,
              course_${courseID}_Posttest${i} LONGTEXT,
              score${i} LONGTEXT,
              status${i} LONGTEXT,
              duration${i} LONGTEXT,
              date${i} TEXT
            `;
          }

          const createTableQuery = `CREATE TABLE IF NOT EXISTS course_${courseID} (${columnDefinitions});`;

          connection.query(createTableQuery, (err) => {
            if (err) {
              console.error('Error creating course table:', err);
              return res.status(500).send('Error creating course table');
            }
            console.log(`Table course_${courseID} created successfully`);
            generateQuizAndRespond(courseID, '/createCourse.html');
          });
        }
      );
    }
  } catch (err) {
    console.error("Error processing files:", err);
    res.status(500).send("Error processing uploaded files.");
  }
});


function safeTrainingLanguageFolder(language) {
  return String(language || '').trim().replace(/[^a-zA-Z0-9 _-]/g, '').replace(/\s+/g, ' ') || 'Default';
}

function saveTrainingLanguageRows(subCourseID, courseSource, materials, contentType, callback) {
  if (!materials.length) return callback(null);
  const values = materials.map(item => [subCourseID, courseSource, item.language, item.uploadPath, contentType]);
  connection.query(
    `INSERT INTO training_material_languages
       (subCourseID, courseSource, languageName, filePath, contentType)
     VALUES ?
     ON DUPLICATE KEY UPDATE filePath = VALUES(filePath), contentType = VALUES(contentType)`,
    [values],
    callback
  );
}

app.post("/uploadTrainingMaterial", uploadFiles, (req, res) => {
  console.log("Training material body received:", req.body);

  let { courseID, courseName, courseDescription, courseDate, level, mCourseName, contentType } = req.body;
  // Level 1 Management flow (see public/uploadTrainingMaterial.html): no
  // Department/Segment/Process-Line is chosen, the level is fixed to "Level 1",
  // and the course is inserted standalone so it is visible to every learner
  // without enrollment. Existing Level 2+ uploads are unaffected (level1 is absent).
  const isLevel1 = String(req.body.level1 || '').trim() === '1';
  const isRefresher = String(req.body.refresher || '').trim() === '1';
  // Common Level 2/3/4 course: same standalone/no-hierarchy handling as Level 1,
  // but keeps whatever Level (2/3/4) the admin chose instead of forcing Level 1.
  const isCommon = String(req.body.isCommon || '').trim() === '1';
  if (!courseID) {
    courseID = Date.now();
  }

  const materials = [1, 2, 3].map(slot => {
    const file = req.files[`trainingFile${slot}`]?.[0];
    const language = String(req.body[`language${slot}`] || '').trim();
    return file && language ? { file, language: safeTrainingLanguageFolder(language) } : null;
  }).filter(Boolean);
  // Backward compatibility for older cached versions of the upload form.
  const legacyFile = req.files.trainingFile?.[0];
  if (!materials.length && legacyFile) materials.push({ file: legacyFile, language: 'English' });

  if (!materials.length) {
    return res.status(400).send("Training material file is missing!");
  }
  if (new Set(materials.map(item => item.language.toLowerCase())).size !== materials.length) {
    return res.status(400).send('Each uploaded training material must use a different language.');
  }

  contentType = String(contentType || '').toLowerCase();
  if (!['ppt', 'video', 'pdf'].includes(contentType)) {
    return res.status(400).send("Invalid training material type");
  }

  const courseFolder = `${courseID}_training`;
  const baseUploadDir = path.join(__dirname, "uploads", "Training Material");
  const coursePath = path.join(baseUploadDir, courseFolder);

  try {
    if (!fs.existsSync(coursePath)) {
      fs.mkdirSync(coursePath, { recursive: true });
    }

    materials.forEach(item => {
      const languagePath = path.join(coursePath, item.language);
      fs.mkdirSync(languagePath, { recursive: true });
      const savedFileName = `${courseID}_${path.basename(item.file.originalname)}`;
      fs.writeFileSync(path.join(languagePath, savedFileName), item.file.buffer);
      item.uploadPath = `uploads/Training Material/${courseFolder}/${item.language}/${savedFileName}`;
    });

    // Retain one primary path in subcourses for all existing code; language
    // variants are held in training_material_languages.
    const uploadPath = materials[0].uploadPath;

    if (isLevel1) {
      level = 'Level 1';
    } else if (isRefresher) {
      level = 'Refresher';
    } else if (!level || level.trim() === '') {
      level = 'default';
    }

    if (isRefresher) {
      insertRefresherSubcourseFromUpload(
        { ...req.body, courseID, courseName, courseDescription, courseDate, level },
        uploadPath,
        'training',
        contentType,
        (refresherError, refresherResult) => {
          if (refresherError) {
            console.error('Error saving refresher training material:', refresherError);
            return res.status(500).send(refresherError.message || 'Error saving refresher training material');
          }
          saveTrainingLanguageRows(refresherResult.insertId, 'refresher', materials, contentType, (languageError) => {
            if (languageError) {
              console.error('Error saving refresher language materials:', languageError);
              return res.status(500).send('Course was created, but its language files could not be registered.');
            }
            return res.send(`
            <p>Refresher training material uploaded successfully!</p>
            <script>
              const uploadConfirmation = confirm('Refresher training material uploaded successfully.');
              if (uploadConfirmation) {
                window.location.href = '/refresherCourses.html';
              }
            </script>
            `);
          });
        }
      );
      return;
    }

    insertNormalizedSubcourseFromUpload(
      { ...req.body, courseID, courseName, courseDescription, courseDate, level, mCourseName, skipHierarchy: isLevel1, isCommon },
      uploadPath,
      'training',
      contentType,
      (normalizedError, normalizedResult, usedNormalizedSchema) => {
        if (normalizedError && !shouldFallbackToLegacySchema(normalizedError)) {
          console.error('Error saving normalized training material:', normalizedError);
          return res.status(500).send(normalizedError.message || 'Error saving training material');
        }

        if (!usedNormalizedSchema) {
          return res.status(500).send('Normalized hierarchy tables are required for training material courses.');
        }

        const postUploadRedirect = isLevel1
          ? '/l1Courses.html'
          : isCommon
            ? `/commonCourses.html?level=${encodeURIComponent(level || '')}`
            : `/l2Courses.html?mCourseID=${encodeURIComponent(req.body.mCourseID || '')}&stationID=${encodeURIComponent(req.body.stationID || '')}`;

        saveTrainingLanguageRows(normalizedResult.insertId, 'regular', materials, contentType, (languageError) => {
          if (languageError) {
            console.error('Error saving training language materials:', languageError);
            return res.status(500).send('Course was created, but its language files could not be registered.');
          }
          return res.send(`
          <p>Training material uploaded successfully!</p>
          <script>
            const uploadConfirmation = confirm('Training material uploaded successfully.');
            if (uploadConfirmation) {
              window.location.href = '${postUploadRedirect}';
            }
          </script>
          `);
        });
      }
    );
  } catch (err) {
    console.error("Error processing training material:", err);
    res.status(500).send("Error processing training material.");
  }
});


app.get('/api/training-material/:subCourseID', (req, res) => {
  // Refresher training material lives in refresher_subcourses (its own
  // auto-increment ID space) - caller flags this with ?source=refresher, same
  // convention as the SCORM save route and the admin courseDetails routes.
  const isRefresher = req.query.source === 'refresher';
  const courseTable = isRefresher ? 'refresher_subcourses' : 'subcourses';
  const query = `
    SELECT subCourseID, subCourseName, subCourseDescription, subCoursePath, contentType
    FROM ${courseTable}
    WHERE subCourseID = ?
      AND courseType = 'training'
    LIMIT 1
  `;

  connection.query(query, [req.params.subCourseID], (error, results) => {
    if (error) {
      console.error('Error fetching training material:', error);
      return res.status(500).json({ error: 'Database error' });
    }
    if (!results.length) {
      return res.status(404).json({ error: 'Training material not found' });
    }

    const course = results[0];
    const courseSource = isRefresher ? 'refresher' : 'regular';
    connection.query(
      `SELECT languageName, filePath, contentType
       FROM training_material_languages
       WHERE subCourseID = ? AND courseSource = ? ORDER BY id`,
      [course.subCourseID, courseSource],
      (languageError, languageRows) => {
        if (languageError) {
          console.error('Error fetching training material languages:', languageError);
          return res.status(500).json({ error: 'Database error' });
        }
        const requestedLanguage = String(req.query.language || '').trim().toLowerCase();
        const selected = languageRows.find(row => row.languageName.toLowerCase() === requestedLanguage)
          || languageRows[0];
        res.json({
          courseID: course.subCourseID,
          courseName: course.subCourseName,
          courseDescription: course.subCourseDescription,
          contentType: selected?.contentType || course.contentType,
          selectedLanguage: selected?.languageName || null,
          languages: languageRows.map(row => ({ language: row.languageName, contentType: row.contentType })),
          fileUrl: `/${selected?.filePath || course.subCoursePath}`
        });
      }
    );
  });
});

// ---------------- PREVIOUS/OFFLINE USER IMPORT ----------------
// The uploaded matrix is intentionally stored as a course-ID boundary on the
// user. Reports synthesize a 100 mark for those IDs; courses added later are
// therefore N/A instead of an accidental Fail.
function normalizePreviousHeader(value) {
  return String(value == null ? '' : value).trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function previousCellHasTraining(value) {
  const text = String(value == null ? '' : value).trim().toLowerCase();
  return text !== '' && !['-', 'na', 'n/a', 'not assigned', 'l1/l1'].includes(text);
}

app.post('/upload-previous-users', upload.single('previousUsersFile'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded.' });
    const workbook = xlsx.readFile(req.file.path);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    // Skill-matrix workbooks usually have a title and several merged heading
    // rows before the actual employee header row. Do not let sheet_to_json
    // assume row 1 is the header, otherwise every imported field is blank.
    const matrixRows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
    const headerIndex = matrixRows.findIndex(row => {
      const values = row.map(normalizePreviousHeader);
      return values.includes('name') && values.some(value =>
        ['employeeid', 'employeeno', 'empid', 'empno'].includes(value)
      );
    });
    if (headerIndex < 0) {
      return res.status(400).json({ success: false, message: 'Could not find the matrix header row. Expected Name and Employee No/Employee ID.' });
    }
    const headers = matrixRows[headerIndex];
    const rawRows = matrixRows.slice(headerIndex + 1)
      .filter(row => row.some(value => String(value).trim() !== ''))
      .map(row => headers.reduce((obj, header, columnIndex) => {
        if (String(header).trim() !== '') obj[header] = row[columnIndex] == null ? '' : row[columnIndex];
        return obj;
      }, {}));
    const [courses] = await connection.promise().query(
      `SELECT subCourseID, subCourseName, subCourseLevel FROM subcourses
       WHERE courseType IN ('assessment', 'training', 'scorm', 'practical')`
    );
    const courseByHeader = new Map();
    courses.forEach(course => {
      courseByHeader.set(normalizePreviousHeader(course.subCourseName), course);
      courseByHeader.set(`course${course.subCourseID}`, course);
      courseByHeader.set(String(course.subCourseID), course);
    });

    const resolveCourse = header => {
      const normalizedHeader = normalizePreviousHeader(header);
      const exact = courseByHeader.get(normalizedHeader);
      if (exact) return exact;
      // Matrix headers often contain a longer description than the LMS
      // course title. Accept a unique meaningful containment match as well.
      const candidates = courses.filter(course => {
        const courseHeader = normalizePreviousHeader(course.subCourseName);
        return courseHeader.length > 4 && (courseHeader.includes(normalizedHeader) || normalizedHeader.includes(courseHeader));
      });
      return candidates.length === 1 ? candidates[0] : null;
    };

    const rows = rawRows.map((raw, index) => {
      const normalized = {};
      Object.keys(raw).forEach(key => { normalized[normalizePreviousHeader(key)] = raw[key]; });
      const pick = (...keys) => {
        for (const key of keys) {
          const value = normalized[normalizePreviousHeader(key)];
          if (value != null && String(value).trim() !== '') return String(value).trim();
        }
        return '';
      };
      const matchedCourseIDs = [];
      Object.keys(raw).forEach(header => {
        const course = resolveCourse(header);
        if (course && previousCellHasTraining(raw[header])) matchedCourseIDs.push(Number(course.subCourseID));
      });
      const name = pick('name', 'full name', 'fullname');
      const employeeID = pick('employee id', 'employeeid', 'employee no', 'employeeno', 'emp id', 'empid', 'emp no', 'empno');
      const suppliedUName = pick('username', 'user name', 'uname', 'login id', 'login');
      return {
        row: headerIndex + index + 2,
        name,
        employeeID,
        // The supplied matrix has no login columns. Use a deterministic
        // temporary login so the imported person can still exist in the LMS.
        uName: suppliedUName || (employeeID ? `prev_${employeeID}` : ''),
        uPass: pick('password', 'pass', 'upass') || 'Previous@123',
        department: pick('department', 'dept'),
        uRole: pick('role', 'urole') || 'Employee',
        dateOfJoining: pick('date of joining', 'dateofjoining', 'doj'),
        matchedCourseIDs: [...new Set(matchedCourseIDs)],
        invalid: !name || !employeeID || !matchedCourseIDs.length,
        blockReason: !matchedCourseIDs.length ? 'No course cells matched the current course catalog' : ''
      };
    });
    res.json({ success: true, rows, courses: courses.map(c => ({ subCourseID: c.subCourseID, courseName: c.subCourseName, level: c.subCourseLevel })) });
  } catch (error) {
    console.error('Previous-user preview error:', error);
    res.status(500).json({ success: false, message: 'Failed to process previous-user file' });
  } finally {
    if (req.file?.path) fs.unlink(req.file.path, () => {});
  }
});

app.post('/confirm-previous-users', express.json({ limit: '50mb' }), async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ success: false, message: 'No rows to import' });
    const db = connection.promise();
    const nowDate = new Date().toISOString().slice(0, 10);
    const nowTime = new Date().toLocaleTimeString('en-US');
    let inserted = 0;
    for (const row of rows) {
      const name = String(row.name || '').trim();
      const uName = String(row.uName || '').trim();
      const courseIDs = [...new Set((row.matchedCourseIDs || []).map(Number).filter(Number.isFinite))];
      if (!name || !uName || !courseIDs.length) continue;
      const [existing] = await db.query('SELECT uniqueID FROM users WHERE uName = ? LIMIT 1', [uName]);
      if (existing.length) continue;
      const [insertResult] = await db.query(
        `INSERT INTO users
          (name, employeeID, uName, uPass, department, uRole, dateOfJoining,
           registerDate, registerTime, photo, photoPath, isPreviousUser, previousCourseIDs)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'default.png', '/photos/default.png', 1, ?)`,
        [name, row.employeeID || '', uName, row.uPass || '', row.department || '', row.uRole || 'Employee',
          row.dateOfJoining || null, nowDate, nowTime, JSON.stringify(courseIDs)]
      );
      // Historical completion is already verified offline, so it enters the
      // certification pipeline as acknowledged. The UI still labels it
      // "Previous User" rather than presenting it as a normal LMS pass.
      await db.query(
        `INSERT INTO l1completedusers
          (uniqueID, level1StartDate, levelDate, l1Status, acknowledgeDate)
         VALUES (?, ?, ?, 'Pass', NOW())
         ON DUPLICATE KEY UPDATE
           l1Status = 'Pass', acknowledgeDate = VALUES(acknowledgeDate)`,
        [insertResult.insertId, nowDate, nowDate]
      );
      inserted += 1;
    }
    res.json({ success: true, inserted });
  } catch (error) {
    console.error('Previous-user import error:', error);
    res.status(500).json({ success: false, message: 'Failed to import previous users' });
  }
});

// ---------------- PREVIOUS USER LAYOUT IMPORT ----------------
// Layout files carry one row per person plus hierarchy/level columns instead
// of one column per course. The hierarchy is resolved against the current LMS
// master data, then the user's historical course boundary is derived from the
// selected level and assigned station.
app.post('/upload-previous-user-layout', upload.single('layoutUsersFile'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded.' });
    const workbook = xlsx.readFile(req.file.path);
    const sheetSets = workbook.SheetNames.map(sheetName => {
      const matrixRows = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '', raw: false });
      const headerIndex = matrixRows.findIndex(row => {
        const values = row.map(normalizePreviousHeader);
        return values.some(v => ['empname', 'name', 'fullname'].includes(v)) &&
          values.some(v => ['empid', 'employeeid', 'employeenumber', 'employeeno', 'empno'].includes(v));
      });
      if (headerIndex < 0) return null;
      return {
        sheetName,
        headerIndex,
        headers: matrixRows[headerIndex],
        rawRows: matrixRows.slice(headerIndex + 1).filter(row => row.some(v => String(v).trim() !== ''))
      };
    }).filter(Boolean);
    if (!sheetSets.length) return res.status(400).json({ success: false, message: 'Expected a Name column and an Employee Number/Employee ID column.' });
    const db = connection.promise();
    const [[departments], [areas], [mcourses], [stations], [usedEmployeeIDs]] = await Promise.all([
      db.query('SELECT deptID, deptName FROM departments'),
      db.query('SELECT areaID, deptID, areaName FROM areas'),
      db.query('SELECT mCourseID, deptID, areaID, mCourseName FROM mcourses'),
      db.query('SELECT stationID, deptID, areaID, mCourseID, stationName FROM stations'),
      db.query("SELECT employeeID FROM users WHERE employeeID REGEXP '^NA[0-9]+$'")
    ]);
    const occupiedEmployeeIDs = new Set(usedEmployeeIDs.map(row => String(row.employeeID || '').trim().toUpperCase()));
    let nextNaNumber = usedEmployeeIDs.reduce((highest, row) => {
      const match = String(row.employeeID || '').trim().toUpperCase().match(/^NA(\d+)$/);
      return match ? Math.max(highest, Number(match[1])) : highest;
    }, 0) + 1;
    const generatedEmployeeIDs = new Map();
    const nextGeneratedEmployeeID = identityKey => {
      if (generatedEmployeeIDs.has(identityKey)) return generatedEmployeeIDs.get(identityKey);
      let candidate;
      do candidate = `NA${nextNaNumber++}`; while (occupiedEmployeeIDs.has(candidate));
      occupiedEmployeeIDs.add(candidate);
      generatedEmployeeIDs.set(identityKey, candidate);
      return candidate;
    };
    const findMaster = (items, value, nameKey, extra = () => true) => {
      const needle = normalizePreviousHeader(value);
      if (!needle) return null;
      const scoped = items.filter(extra);
      const exact = scoped.find(item => normalizePreviousHeader(item[nameKey]) === needle);
      if (exact) return exact;
      const matches = scoped.filter(item => {
        const haystack = normalizePreviousHeader(item[nameKey]);
        return haystack.length > 3 && (haystack.includes(needle) || needle.includes(haystack));
      });
      return matches.length === 1 ? matches[0] : null;
    };
    const findProcess = (value, department, area) => {
      const direct = findMaster(mcourses, value, 'mCourseName', m => (!department || Number(m.deptID) === Number(department.deptID)) && (!area || Number(m.areaID) === Number(area.areaID)));
      if (direct) return direct;
      const needle = normalizePreviousHeader(value);
      const scoped = mcourses.filter(m => (!department || Number(m.deptID) === Number(department.deptID)) && (!area || Number(m.areaID) === Number(area.areaID)));
      if (needle === 'faceodgrinding') return scoped.find(m => { const n = normalizePreviousHeader(m.mCourseName); return n.includes('face') && n.includes('od') && n.includes('grinding'); }) || null;
      if (needle === 'boregrinding') return scoped.find(m => { const n = normalizePreviousHeader(m.mCourseName); return n.includes('bore') && n.includes('grinding'); }) || null;
      return null;
    };
    const findStation = (value, mCourse) => {
      const scoped = stations.filter(s => !mCourse || Number(s.mCourseID) === Number(mCourse.mCourseID));
      const needle = normalizePreviousHeader(value);
      const aliases = { turning: 'turninglinestation', obp: 'obpline' };
      const target = aliases[needle] || needle;
      return scoped.find(s => normalizePreviousHeader(s.stationName) === target) ||
        findMaster(scoped, value, 'stationName') || null;
    };
    const rows = [];
    sheetSets.forEach(({ sheetName, headerIndex, headers, rawRows }) => rawRows.forEach((values, index) => {
      const raw = headers.reduce((obj, header, col) => { obj[normalizePreviousHeader(header)] = values[col] ?? ''; return obj; }, {});
      const pick = (...keys) => { for (const key of keys) if (String(raw[normalizePreviousHeader(key)] ?? '').trim()) return String(raw[normalizePreviousHeader(key)]).trim(); return ''; };
      const sourceName = pick('emp.name', 'emp name', 'name', 'full name').replace(/^#+\s*/, '').trim();
      const name = sourceName ? `# ${sourceName}` : '';
      const suppliedEmployeeID = pick('emp id', 'employee id', 'employee number', 'employee no', 'emp no', 'employeeid');
      const joiningDate = pick('joining date', 'date of joining', 'doj');
      const placeholderEmployeeID = /^(?:NAPS|NAPPS|NA|N\/A)$/i.test(suppliedEmployeeID.trim());
      const identityKey = `${normalizePreviousHeader(sourceName)}|${normalizePreviousHeader(joiningDate)}`;
      const employeeID = (!suppliedEmployeeID || placeholderEmployeeID)
        ? nextGeneratedEmployeeID(identityKey || `row-${headerIndex + index + 2}`)
        : suppliedEmployeeID;
      const departmentName = pick('department', 'deparment', 'dept');
      const segmentName = pick('segment', 'area');
      const processName = pick('process', 'line', 'mcourse', 'process line');
      const department = findMaster(departments, departmentName, 'deptName');
      const area = findMaster(areas, segmentName, 'areaName', a => !department || Number(a.deptID) === Number(department.deptID));
      const mCourse = findProcess(processName, department, area);
      const assignments = [];
      const explicitMachine = pick('machine', 'station', 'sub process', 'subprocess');
      const explicitLevel = Number(pick('level').replace(/[^0-9]/g, '')) || 0;
      if (explicitMachine || explicitLevel) assignments.push({ machineName: explicitMachine, level: explicitLevel });
      if (!assignments.length) {
        const metadata = new Set(['srno', 'name', 'empname', 'fullname', 'empid', 'employeeid', 'employeenumber', 'employeeno', 'empno', 'joiningdate', 'dateofjoining', 'doj', 'department', 'deparment', 'dept', 'segment', 'area', 'process', 'line', 'mcourse', 'processline']);
        Object.entries(raw).forEach(([key, value]) => {
          if (metadata.has(key)) return;
          const level = Number(String(value).replace(/[^0-9]/g, '')) || 0;
          if ([1, 2, 3, 4].includes(level)) assignments.push({ machineName: headers.find(h => normalizePreviousHeader(h) === key) || key, level });
        });
      }
      if (!assignments.length) assignments.push({ machineName: '', level: 0 });
      assignments.forEach(({ machineName, level }) => {
        const station = findStation(machineName, mCourse);
        const canCreateStation = Boolean(machineName && department && area && mCourse && !station);
        const errors = [];
        if (!name) errors.push('Name required');
        if (!department) errors.push(`Department not found: ${departmentName || '(blank)'}`);
        if (!area) errors.push(`Segment/Area not found: ${segmentName || '(blank)'}`);
        if (!mCourse) errors.push(`Process/Line not found: ${processName || '(blank)'}`);
        if (!station && !canCreateStation) errors.push(`Machine/Station not found: ${machineName || '(blank)'}`);
        if (![1, 2, 3, 4].includes(level)) errors.push('Level must be 1, 2, 3 or 4');
        rows.push({ row: `${sheetName} ${headerIndex + index + 2}`, name, employeeID, generatedEmployeeID: !suppliedEmployeeID || placeholderEmployeeID, dateOfJoining: joiningDate, departmentName, segmentName, processName, machineName, level,
          deptID: department?.deptID || null, areaID: area?.areaID || null, mCourseID: mCourse?.mCourseID || null, stationID: station?.stationID || null, createStation: canCreateStation,
          invalid: errors.length > 0, blockReason: errors.join('; ') });
      });
    }));
    res.json({ success: true, rows });
  } catch (error) {
    console.error('Previous-user layout preview error:', error);
    res.status(500).json({ success: false, message: 'Failed to process layout file' });
  } finally { if (req.file?.path) fs.unlink(req.file.path, () => {}); }
});

app.post('/confirm-previous-user-layout', express.json({ limit: '50mb' }), async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ success: false, message: 'No rows to import' });
    const db = connection.promise();
    const nowDate = new Date().toISOString().slice(0, 10);
    let inserted = 0;
    let assignmentsSaved = 0;
    const [usedIdRows] = await db.query("SELECT employeeID FROM users WHERE employeeID REGEXP '^NA[0-9]+$'");
    const occupiedEmployeeIDs = new Set(usedIdRows.map(row => String(row.employeeID || '').trim().toUpperCase()));
    let nextNaNumber = usedIdRows.reduce((highest, row) => {
      const match = String(row.employeeID || '').trim().toUpperCase().match(/^NA(\d+)$/);
      return match ? Math.max(highest, Number(match[1])) : highest;
    }, 0) + 1;
    const allocateEmployeeID = () => {
      let candidate;
      do candidate = `NA${nextNaNumber++}`; while (occupiedEmployeeIDs.has(candidate));
      occupiedEmployeeIDs.add(candidate);
      return candidate;
    };
    const normalizeImportDate = value => {
      const text = String(value || '').trim();
      if (!text) return null;
      if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
      let match = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
      if (!match) return null;
      let [, first, second, year] = match;
      if (year.length === 2) year = `20${year}`;
      const firstNum = Number(first), secondNum = Number(second);
      // Hyphenated client dates are DD-MM-YYYY. Slash dates in this workbook
      // are Excel's M/D/YY display.
      const day = text.includes('-') ? firstNum : secondNum;
      const month = text.includes('-') ? secondNum : firstNum;
      if (month < 1 || month > 12 || day < 1 || day > 31) return null;
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    };
    for (const row of rows) {
      if (row.invalid || !row.name || !row.deptID || !row.areaID || !row.mCourseID || (!row.stationID && !row.createStation)) continue;
      const sourceEmployeeID = String(row.employeeID || '').trim();
      const employeeID = (!sourceEmployeeID || /^(?:NAPS|NAPPS|NA|N\/A)$/i.test(sourceEmployeeID)) ? allocateEmployeeID() : sourceEmployeeID;
      const importedName = `# ${String(row.name).replace(/^#+\s*/, '').trim()}`;
      let stationID = Number(row.stationID) || 0;
      if (!stationID && row.createStation) {
        const [stationRows] = await db.query('SELECT stationID FROM stations WHERE mCourseID = ? AND LOWER(TRIM(stationName)) = LOWER(TRIM(?)) LIMIT 1', [row.mCourseID, row.machineName]);
        if (stationRows.length) stationID = Number(stationRows[0].stationID);
        else {
          const [stationResult] = await db.query(
            `INSERT INTO stations (deptID, areaID, mCourseID, stationName, stationDescription, stationDate)
             VALUES (?, ?, ?, ?, 'Created from previous-user workbook', ?)`,
            [row.deptID, row.areaID, row.mCourseID, row.machineName, nowDate]
          );
          stationID = Number(stationResult.insertId);
        }
      }
      const [existing] = await db.query('SELECT uniqueID, previousCourseIDs FROM users WHERE employeeID = ? LIMIT 1', [employeeID]);
      let uniqueID;
      let existingCourseIDs = [];
      if (existing.length) {
        uniqueID = Number(existing[0].uniqueID);
        try { existingCourseIDs = JSON.parse(existing[0].previousCourseIDs || '[]'); } catch (_) { existingCourseIDs = []; }
        await db.query('UPDATE users SET name = ?, isPreviousUser = 1 WHERE uniqueID = ?', [importedName, uniqueID]);
      } else {
        const [userResult] = await db.query(
          `INSERT INTO users (name, employeeID, uName, uPass, department, uRole, dateOfJoining, registerDate, registerTime, photo, photoPath, isPreviousUser)
           VALUES (?, ?, ?, 'Previous@123', ?, 'Employee', ?, ?, NOW(), 'default.png', '/photos/default.png', 1)`,
          [importedName, employeeID, `prev_${employeeID}`, row.departmentName || '', normalizeImportDate(row.dateOfJoining), nowDate]
        );
        uniqueID = Number(userResult.insertId);
        inserted += 1;
      }
      const [courseRows] = await db.query(
        `SELECT subCourseID FROM subcourses
         WHERE courseType IN ('assessment', 'training', 'scorm', 'practical')
           AND ((subCourseLevel = 'Level 1') OR (subCourseLevel IN (?) AND mCourseID = ? AND (stationID = 0 OR stationID = ?)))`,
        [Array.from({ length: row.level }, (_, i) => `Level ${i + 1}`), row.mCourseID, stationID]
      );
      const courseIDs = [...new Set(existingCourseIDs.concat(courseRows.map(c => Number(c.subCourseID))).map(Number).filter(Number.isFinite))];
      await db.query('UPDATE users SET previousCourseIDs = ? WHERE uniqueID = ?', [JSON.stringify(courseIDs), uniqueID]);
      const [enrollmentRows] = await db.query(
        `SELECT enrollID FROM enrollstatus WHERE uniqueID = ? AND deptID = ? AND areaID = ? AND mCourseID = ? AND stationID = ? LIMIT 1`,
        [uniqueID, row.deptID, row.areaID, row.mCourseID, stationID]
      );
      if (!enrollmentRows.length) {
        await db.query(`INSERT INTO enrollstatus (uniqueID, deptID, areaID, mCourseID, stationID, enrollDate, startDate, enrollStatus) VALUES (?, ?, ?, ?, ?, ?, ?, 'Active')`, [uniqueID, row.deptID, row.areaID, row.mCourseID, stationID, nowDate, nowDate]);
        assignmentsSaved += 1;
      }
      await db.query(`INSERT INTO l1completedusers (uniqueID, level1StartDate, levelDate, l1Status, acknowledgeDate) VALUES (?, ?, ?, 'Pass', NOW()) ON DUPLICATE KEY UPDATE l1Status = 'Pass', acknowledgeDate = VALUES(acknowledgeDate)`, [uniqueID, nowDate, nowDate]);
      for (let level = 2; level <= Math.min(4, Number(row.level) || 0); level += 1) {
        await db.query(
          `INSERT INTO l${level}completedusers (uniqueID, deptID, areaID, mCourseID, stationID, levelStartDate, levelDate, l${level}Status, acknowledgeDate)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'Pass', NOW())
           ON DUPLICATE KEY UPDATE l${level}Status = 'Pass', acknowledgeDate = VALUES(acknowledgeDate)`,
          [uniqueID, row.deptID, row.areaID, row.mCourseID, stationID, nowDate, nowDate]
        );
      }
      if (Number(row.level) >= 2) {
        await db.query(
          `INSERT INTO skillmatrix_station_skills (uniqueID, deptID, areaID, mCourseID, stationID, requiredLevel)
           VALUES (?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE requiredLevel = GREATEST(requiredLevel, VALUES(requiredLevel)), updatedAt = CURRENT_TIMESTAMP`,
          [uniqueID, row.deptID, row.areaID, row.mCourseID, stationID, Math.min(4, Number(row.level))]
        );
      }
    }
    res.json({ success: true, inserted, assignmentsSaved });
  } catch (error) { console.error('Previous-user layout import error:', error); res.status(500).json({ success: false, message: 'Failed to import layout users' }); }
});


app.post('/api/training-material/:subCourseID/complete', express.json(), (req, res) => {
  if (!req.session || !req.session.user || !req.session.user.uniqueID) {
    return res.status(401).json({ success: false, error: 'User not authenticated' });
  }

  const uniqueID = req.session.user.uniqueID;
  const subCourseID = req.params.subCourseID;
  // Same source=refresher convention as the GET route above and the SCORM
  // save route - refresher training material/completion is tracked in its
  // own refresher_subcourses/refresher_traininggrades tables.
  const isRefresher = req.query.source === 'refresher';
  const courseTable = isRefresher ? 'refresher_subcourses' : 'subcourses';
  const gradesTable = isRefresher ? 'refresher_traininggrades' : 'traininggrades';

  if (!isRefresher) {
    connection.query(
      `SELECT locked FROM refresher_course_locks
       WHERE uniqueID = ? AND subCourseID = ? AND locked = 1 LIMIT 1`,
      [uniqueID, subCourseID],
      (lockError, lockRows) => {
        if (lockError) {
          console.error('Error checking refresher training lock:', lockError);
          return res.status(500).json({ success: false, error: 'Database error' });
        }
        if (lockRows.length) {
          return res.status(423).json({
            success: false,
            error: 'This refresher course is locked after a failed attempt. Ask an administrator to select Retrain.'
          });
        }
        completeTrainingMaterial();
      }
    );
    return;
  }

  completeTrainingMaterial();

  function completeTrainingMaterial() {
  const courseQuery = `
    SELECT deptID, areaID, mCourseID, coMCourseID, subCourseID
    FROM ${courseTable}
    WHERE subCourseID = ?
      AND courseType = 'training'
    LIMIT 1
  `;

  connection.query(courseQuery, [subCourseID], (courseError, courseRows) => {
    if (courseError) {
      console.error('Error loading training course for completion:', courseError);
      return res.status(500).json({ success: false, error: 'Database error' });
    }
    if (!courseRows.length) {
      return res.status(404).json({ success: false, error: 'Training course not found' });
    }

    const course = courseRows[0];
    const now = getFormattedDateTimeIST();
    const [courseDate, courseTime] = now.split(' ');

    const attemptQuery = `
      SELECT COALESCE(MAX(noOfAttemptss), 0) + 1 AS nextAttempt
      FROM ${gradesTable}
      WHERE uniqueID = ? AND subCourseID = ?
    `;

    connection.query(attemptQuery, [uniqueID, subCourseID], (attemptError, attemptRows) => {
      if (attemptError) {
        console.error('Error loading training attempt count:', attemptError);
        return res.status(500).json({ success: false, error: 'Database error' });
      }

      const nextAttempt = attemptRows[0]?.nextAttempt || 1;
      const insertQuery = `
        INSERT INTO ${gradesTable}
          (deptID, areaID, mCourseID, coMCourseID, subCourseID, uniqueID, noOfAttemptss,
           pretestScore, score, status, duration, courseDate, courseTime, trainerUniqueID)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

      connection.query(
        insertQuery,
        [
          course.deptID,
          course.areaID,
          course.mCourseID,
          course.coMCourseID,
          course.subCourseID,
          uniqueID,
          nextAttempt,
          null,
          100,
          'Completed',
          0,
          courseDate,
          courseTime,
          null
        ],
        (insertError, result) => {
          if (insertError) {
            console.error('Error saving training completion:', insertError);
            return res.status(500).json({ success: false, error: 'Database error' });
          }
          res.json({ success: true, gradeID: result.insertId, score: 100, status: 'Completed' });
        }
      );
    });
  });
  }
});


// Records a Level 1+ assessment attempt into the normalized schema
// (courseattempts + coursegrades), with Pass/Fail computed dynamically from
// subcourses.subCoursePassing. This is the backend half of the POST
// /submitPosttestData call already made by public/js/trainingAss_Template.js
// (the employee-facing quiz used by the new /uploadExcel flow) - that
// frontend call already existed but had no live backend route (only dead,
// commented-out code below), so assessment scores were never persisted
// anywhere. No employee-facing file is touched here; this only implements
// the backend half of a contract the employee-facing quiz already uses.
// This is also what now drives "Level 1 completed" (Assessments only) for
// the L1 -> L2 acknowledge pipeline (see /api/l1/acknowledge/users below).
app.post('/submitPosttestData', express.json(), async (req, res) => {
  const { courseID, uniqueID, score, duration, date, allAnswersJson } = req.body || {};
  const subCourseID = Number(courseID);
  const sessionUniqueID = req.session && req.session.user && req.session.user.uniqueID;
  const userUniqueID = Number(uniqueID) || Number(sessionUniqueID);

  if (!subCourseID || !userUniqueID || score === undefined || score === null) {
    return res.status(400).json({ success: false, error: 'courseID, uniqueID and score are required' });
  }

  try {
    const [lockRows] = await connection.promise().query(
      `SELECT locked FROM refresher_course_locks
       WHERE uniqueID = ? AND subCourseID = ? AND locked = 1 LIMIT 1`,
      [userUniqueID, subCourseID]
    );
    if (lockRows.length) {
      return res.status(423).json({
        success: false,
        error: 'This refresher course is locked after a failed attempt. Ask an administrator to select Retrain.'
      });
    }
  } catch (lockError) {
    console.error('Error checking refresher assessment lock:', lockError);
    return res.status(500).json({ success: false, error: 'Database error' });
  }

  const courseQuery = `
    SELECT subCourseID, deptID, areaID, mCourseID, coMCourseID, subCourseLevel, subCoursePassing
    FROM subcourses
    WHERE subCourseID = ?
    LIMIT 1
  `;

  connection.query(courseQuery, [subCourseID], async (courseError, courseRows) => {
    if (courseError) {
      console.error('Error loading subcourse for posttest submission:', courseError);
      return res.status(500).json({ success: false, error: 'Database error' });
    }
    if (!courseRows.length) {
      return res.status(404).json({ success: false, error: 'Course not found' });
    }

    const course = courseRows[0];
    const numericScore = Number(score) || 0;
    const passingThreshold = await resolveEffectiveThreshold(scopeForSubcourseLevel(course.subCourseLevel), course.subCoursePassing);
    const status = numericScore >= passingThreshold ? 'Pass' : 'Fail';

    const now = getFormattedDateTimeIST();
    const [defaultDate, defaultTime] = now.split(' ');
    const courseDate = date || defaultDate;
    const courseTime = defaultTime;

    const attemptCountQuery = `
      SELECT COALESCE(MAX(noOfAttempts), 0) + 1 AS nextAttempt
      FROM courseattempts
      WHERE uniqueID = ? AND subCourseID = ?
    `;

    connection.query(attemptCountQuery, [userUniqueID, subCourseID], (attemptCountError, attemptCountRows) => {
      if (attemptCountError) {
        console.error('Error counting posttest attempts:', attemptCountError);
        return res.status(500).json({ success: false, error: 'Database error' });
      }

      const nextAttempt = attemptCountRows[0]?.nextAttempt || 1;

      const insertAttemptQuery = `
        INSERT INTO courseattempts
          (deptID, areaID, mCourseID, coMCourseID, subCourseID, uniqueID, noOfAttempts,
           pretestScore, score, status, duration, courseDate, courseTime)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

      connection.query(
        insertAttemptQuery,
        [
          course.deptID, course.areaID, course.mCourseID, course.coMCourseID, subCourseID,
          userUniqueID, nextAttempt, null, numericScore, status, String(duration || 0), courseDate, courseTime
        ],
        (attemptInsertError, attemptResult) => {
          if (attemptInsertError) {
            console.error('Error saving posttest attempt:', attemptInsertError);
            return res.status(500).json({ success: false, error: 'Database error' });
          }

          const attemptID = attemptResult.insertId;

          // Best-effort per-question breakdown - non-fatal if it fails.
          try {
            const answers = JSON.parse(allAnswersJson || '[]');
            if (Array.isArray(answers) && answers.length) {
              const itemRows = answers.map(a => [
                attemptID, course.deptID, course.areaID, course.mCourseID, course.coMCourseID, subCourseID,
                a.question || null, a.userAnswer || null, a.correctAnswer || null, a.isCorrect ? 1 : 0
              ]);
              connection.query(
                `INSERT INTO attempts_items
                   (attemptID, deptID, areaID, mCourseID, coMCourseID, subCourseID, questionText, userAnswer, practicalAnswer, isCorrect)
                 VALUES ?`,
                [itemRows],
                (itemsError) => {
                  if (itemsError) console.error('Error saving attempt items (non-fatal):', itemsError);
                }
              );
            }
          } catch (parseError) {
            console.error('Error parsing allAnswersJson (non-fatal):', parseError);
          }

          const insertGradeQuery = `
            INSERT INTO coursegrades
              (deptID, areaID, mCourseID, coMCourseID, subCourseID, uniqueID, attemptID, noOfAttempts,
               pretestScore, score, status, duration, courseDate, courseTime)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `;

          connection.query(
            insertGradeQuery,
            [
              course.deptID, course.areaID, course.mCourseID, course.coMCourseID, subCourseID,
              userUniqueID, attemptID, nextAttempt, null, numericScore, status, String(duration || 0), courseDate, courseTime
            ],
            (gradeError, gradeResult) => {
              if (gradeError) {
                console.error('Error saving posttest grade:', gradeError);
                return res.status(500).json({ success: false, error: 'Database error' });
              }
              if (status === 'Fail') {
                lockCourseIfCurrentRefresherIsDue(userUniqueID, subCourseID).catch(lockError => {
                  console.error('Failed to apply refresher assessment lock:', lockError);
                });
              }
              res.json({ success: true, attemptID, gradeID: gradeResult.insertId, score: numericScore, status });
            }
          );
        }
      );
    });
  });
});


// ====================================================================
// Level 1 -> Level 2+ progression (Harman-style, minus the day-count /
// holiday / absence duration matrix, which is deferred for a later pass).
// Admin-only routes; nothing here touches employee-facing pages or the
// course-attempting/SCORM flow.
// ====================================================================

// Returns every user's Level 1 assessment status, computed live from
// coursegrades (latest attempt per Level-1 assessment subcourse). A user is
// "Pass" only if they have passed EVERY Level 1 subcourse with
// courseType = 'assessment' (per user's "Assessments only" rule). Users with
// no attempts at all on any Level 1 assessment are omitted unless already
// acknowledged.
app.get('/api/l1/acknowledge/users', (req, res) => {
  const usersQuery = `SELECT uniqueID, name, employeeID, uName, uRole, isPreviousUser, previousCourseIDs FROM users ORDER BY name`;
  // Each user is evaluated only against Level 1 courses assigned to their
  // exact role, plus common courses whose subCourseRoles is blank. This is
  // the same visibility rule used by /getViewscormCourseList. SCORM,
  // practical, assessment and training courses all count toward completion.
  const statusQuery = `
    SELECT
      u.uniqueID,
      sc.subCourseID,
      sc.courseType,
      CASE
        WHEN sc.courseType IN ('assessment', 'scorm') THEN (
          SELECT cg.status FROM coursegrades cg
          WHERE cg.uniqueID = u.uniqueID AND cg.subCourseID = sc.subCourseID
          ORDER BY cg.id DESC LIMIT 1
        )
        WHEN sc.courseType = 'practical' THEN (
          SELECT pe.finalResult FROM practicalevaluations pe
          WHERE pe.uniqueID = u.uniqueID
            AND pe.subCourseID = sc.subCourseID
            AND pe.evaluationStatus = 'Submitted'
          ORDER BY pe.practicalEvalID DESC LIMIT 1
        )
        WHEN sc.courseType = 'training' THEN (
          SELECT tg.status FROM traininggrades tg
          WHERE tg.uniqueID = u.uniqueID AND tg.subCourseID = sc.subCourseID
          ORDER BY tg.id DESC LIMIT 1
        )
      END AS latestStatus
    FROM users u
    JOIN subcourses sc
      ON sc.subCourseLevel = 'Level 1'
      AND sc.courseType IN ('assessment', 'scorm', 'training', 'practical')
      AND (
        sc.subCourseRoles IS NULL
        OR TRIM(sc.subCourseRoles) = ''
        OR FIND_IN_SET(TRIM(u.uRole), sc.subCourseRoles) > 0
      )
  `;
  const ackQuery = `SELECT uniqueID, acknowledgeDate, sentForNextLevel FROM l1completedusers`;

  connection.query(usersQuery, (uErr, users) => {
    if (uErr) {
      console.error('Error loading users for L1 acknowledge list:', uErr);
      return res.status(500).json({ success: false, error: 'Database error' });
    }
    connection.query(statusQuery, (sErr, statusRows) => {
      if (sErr) {
        console.error('Error loading L1 assessment status:', sErr);
        return res.status(500).json({ success: false, error: 'Database error' });
      }
      connection.query(ackQuery, (aErr, ackRows) => {
        if (aErr) {
          console.error('Error loading l1completedusers:', aErr);
          return res.status(500).json({ success: false, error: 'Database error' });
        }

        const requiredMap = new Map();
        const passedMap = new Map();
        const attemptedMap = new Map();
        statusRows.forEach(r => {
          requiredMap.set(r.uniqueID, (requiredMap.get(r.uniqueID) || 0) + 1);
          if (r.latestStatus) {
            attemptedMap.set(r.uniqueID, (attemptedMap.get(r.uniqueID) || 0) + 1);
            const isPassed = r.courseType === 'training'
              ? r.latestStatus === 'Completed'
              : r.latestStatus === 'Pass';
            if (isPassed) {
              passedMap.set(r.uniqueID, (passedMap.get(r.uniqueID) || 0) + 1);
            }
          }
        });
        const ackMap = new Map(ackRows.map(a => [a.uniqueID, a]));

        const result = users
          .map(u => {
            const required = requiredMap.get(u.uniqueID) || 0;
            const passed = passedMap.get(u.uniqueID) || 0;
            const attempted = attemptedMap.get(u.uniqueID) || 0;
            let l1Status = 'No Attempt';
            if (required > 0) {
              if (passed >= required) l1Status = 'Pass';
              else if (attempted > 0) l1Status = 'Fail';
            }
            const ack = ackMap.get(u.uniqueID);
            return {
              uniqueID: u.uniqueID,
              name: u.name,
              employeeID: u.employeeID,
              uName: u.uName,
              uRole: u.uRole,
              totalL1Assessments: required,
              passedL1Assessments: passed,
              l1Status: u.isPreviousUser ? 'Previous User' : l1Status,
              acknowledged: !!ack,
              acknowledgeDate: ack ? ack.acknowledgeDate : null,
              sentForNextLevel: ack ? !!ack.sentForNextLevel : false,
              isPreviousUser: !!u.isPreviousUser,
              previousCourseIDs: u.previousCourseIDs
            };
          })
          .filter(r => r.totalL1Assessments > 0 && (r.l1Status !== 'No Attempt' || r.acknowledged));

        res.json({ success: true, users: result });
      });
    });
  });
});

// ====================================================================
// Level 1 Grades Report (admin-only, read-only). Returns every Level 1
// course as a column and every user's latest score/status for each one, so
// the admin can see marks per person per course in one table - this is
// separate from /api/l1/acknowledge/users, which only returns the
// pass/fail-everything aggregate needed for the acknowledge gate. Level 2+
// grades report is a later follow-up (per user's instruction) - not built
// yet.
app.get('/api/l1/gradesReport', (req, res) => {
  const usersQuery = `SELECT uniqueID, name, employeeID, uName, uRole, isPreviousUser, previousCourseIDs FROM users ORDER BY name`;
  const coursesQuery = `
    SELECT subCourseID, subCourseName AS courseName, courseType, subCoursePassing, subCourseRoles
    FROM subcourses
    WHERE subCourseLevel = 'Level 1' AND courseType IN ('assessment', 'training', 'scorm', 'practical')
    ORDER BY subCourseID
  `;

  connection.query(usersQuery, (uErr, users) => {
    if (uErr) {
      console.error('Error loading users for L1 grades report:', uErr);
      return res.status(500).json({ success: false, error: 'Database error' });
    }
    connection.query(coursesQuery, (cErr, courses) => {
      if (cErr) {
        console.error('Error loading L1 courses for grades report:', cErr);
        return res.status(500).json({ success: false, error: 'Database error' });
      }
      if (!courses.length) {
        return res.json({ success: true, courses: [], users: users.map(u => ({ ...u, grades: {} })) });
      }

      const gradesQuery = `
        SELECT
          u.uniqueID,
          l1c.subCourseID,
          l1c.courseType,
          CASE
            WHEN l1c.courseType IN ('assessment', 'scorm') THEN (
              SELECT cg.score FROM coursegrades cg
              WHERE cg.uniqueID = u.uniqueID AND cg.subCourseID = l1c.subCourseID
              ORDER BY cg.id DESC LIMIT 1
            )
            WHEN l1c.courseType = 'practical' THEN (
              SELECT pe.finalPercent FROM practicalevaluations pe
              WHERE pe.uniqueID = u.uniqueID AND pe.subCourseID = l1c.subCourseID AND pe.evaluationStatus = 'Submitted'
              LIMIT 1
            )
            ELSE (
              SELECT tg.score FROM traininggrades tg
              WHERE tg.uniqueID = u.uniqueID AND tg.subCourseID = l1c.subCourseID
              ORDER BY tg.id DESC LIMIT 1
            )
          END AS latestScore,
          CASE
            WHEN l1c.courseType IN ('assessment', 'scorm') THEN (
              SELECT cg.status FROM coursegrades cg
              WHERE cg.uniqueID = u.uniqueID AND cg.subCourseID = l1c.subCourseID
              ORDER BY cg.id DESC LIMIT 1
            )
            WHEN l1c.courseType = 'practical' THEN (
              SELECT pe.finalResult FROM practicalevaluations pe
              WHERE pe.uniqueID = u.uniqueID AND pe.subCourseID = l1c.subCourseID AND pe.evaluationStatus = 'Submitted'
              LIMIT 1
            )
            ELSE (
              SELECT tg.status FROM traininggrades tg
              WHERE tg.uniqueID = u.uniqueID AND tg.subCourseID = l1c.subCourseID
              ORDER BY tg.id DESC LIMIT 1
            )
          END AS latestStatus
        FROM users u
        JOIN (
          SELECT subCourseID, courseType, subCourseRoles FROM subcourses
          WHERE subCourseLevel = 'Level 1'
            AND courseType IN ('assessment', 'training', 'scorm', 'practical')
        ) l1c
          ON l1c.subCourseRoles IS NULL
          OR TRIM(l1c.subCourseRoles) = ''
          OR FIND_IN_SET(TRIM(u.uRole), l1c.subCourseRoles) > 0
      `;
      connection.query(gradesQuery, (gErr, gradeRows) => {
        if (gErr) {
          console.error('Error loading L1 grades for report:', gErr);
          return res.status(500).json({ success: false, error: 'Database error' });
        }

        // Also pull L1 acknowledgement status (l1completedusers is global, not
        // scoped to a Process/Line) so the report can gate the Certificate
        // button on "admin has acknowledged this user to Level 1" without a
        // second round-trip from the frontend.
        connection.query('SELECT uniqueID, acknowledgeDate FROM l1completedusers', (ackErr, ackRows) => {
          if (ackErr) {
            console.error('Error loading l1completedusers for grades report:', ackErr);
            return res.status(500).json({ success: false, error: 'Database error' });
          }

          const gradeMap = new Map(); // uniqueID -> { subCourseID -> {score, status} }
          const applicableMap = new Map(); // uniqueID -> Set(subCourseID)
          gradeRows.forEach(r => {
            if (!gradeMap.has(r.uniqueID)) gradeMap.set(r.uniqueID, {});
            if (!applicableMap.has(r.uniqueID)) applicableMap.set(r.uniqueID, new Set());
            applicableMap.get(r.uniqueID).add(Number(r.subCourseID));
            gradeMap.get(r.uniqueID)[r.subCourseID] = { score: r.latestScore, status: r.latestStatus };
          });

          const ackMap = new Map(ackRows.map(a => [a.uniqueID, a]));

          const result = users.map(u => {
            const ack = ackMap.get(u.uniqueID);
            const grades = gradeMap.get(u.uniqueID) || {};
            const previousIDs = previousCourseIDSet(u.previousCourseIDs);
            if (u.isPreviousUser) {
              previousIDs.forEach(id => {
                if (!grades[id]) grades[id] = { score: 100, status: 'Previous User' };
              });
            }
            return {
              uniqueID: u.uniqueID,
              name: u.name,
              employeeID: u.employeeID,
              uName: u.uName,
              uRole: u.uRole,
              grades,
              applicableCourseIDs: u.isPreviousUser
                ? Array.from(previousIDs)
                : Array.from(applicableMap.get(u.uniqueID) || []),
              acknowledged: !!ack,
              acknowledgeDate: ack ? ack.acknowledgeDate : null,
              isPreviousUser: !!u.isPreviousUser,
              previousCourseIDs: u.previousCourseIDs
            };
          });

          applyPassingModeToCourseList('l1', courses)
            .then(finalCourses => res.json({ success: true, courses: finalCourses, users: result }))
            .catch(err => {
              console.error('Error applying passing mode to L1 course list:', err);
              res.json({ success: true, courses, users: result }); // fail-open: individual values still correct
            });
        });
      });
    });
  });
});

// ====================================================================
// Admin "Edit Marks" -> "Save Changes" for the Grades Report (L1 and L2+
// panels alike - level-agnostic, since it edits coursegrades by
// uniqueID+subCourseID directly). Admin-only, does not touch the
// employee-facing quiz/SCORM flow or /submitPosttestData.
//
// Only assessment-type and scorm-type courses are editable (both are now
// scored numerically into coursegrades; training-type rows have no numeric
// mark, only a Completed/not-completed status). Re-derives Pass/Fail from
// subcourses.subCoursePassing (default 70), the same rule
// /submitPosttestData/SCORM-save already use, so edited marks stay
// consistent with freshly-submitted ones.
//
// Only updates an EXISTING latest attempt row (the realistic "admin is
// correcting a score the user already has") - it does not fabricate a new
// attempt/courseattempts row for a course the user never attempted, since
// that would require inventing attempt numbers/dates with no real
// submission behind them. Such edits are reported back as "skipped".
// ====================================================================
app.post('/api/admin/grades/bulkUpdate', express.json(), async (req, res) => {
  const edits = Array.isArray(req.body?.edits) ? req.body.edits : [];
  if (!edits.length) {
    return res.status(400).json({ success: false, error: 'No edits provided' });
  }

  try {
    const db = connection.promise();
    let updated = 0;
    const skipped = [];

    for (const edit of edits) {
      const uniqueID = Number(edit.uniqueID);
      const subCourseID = Number(edit.subCourseID);
      const score = Number(edit.score);

      if (!uniqueID || !subCourseID || Number.isNaN(score)) {
        skipped.push({ ...edit, reason: 'Invalid uniqueID/subCourseID/score' });
        continue;
      }

      const [courseRows] = await db.query(
        'SELECT subCourseID, courseType, subCourseLevel, subCoursePassing FROM subcourses WHERE subCourseID = ? LIMIT 1',
        [subCourseID]
      );
      if (!courseRows.length) {
        skipped.push({ ...edit, reason: 'Course not found' });
        continue;
      }
      const course = courseRows[0];
      if (course.courseType !== 'assessment' && course.courseType !== 'scorm') {
        skipped.push({ ...edit, reason: 'Only assessment-type and scorm-type marks are editable' });
        continue;
      }

      const passingThreshold = await resolveEffectiveThreshold(scopeForSubcourseLevel(course.subCourseLevel), course.subCoursePassing);
      const status = score >= passingThreshold ? 'Pass' : 'Fail';

      const [latestRows] = await db.query(
        'SELECT id FROM coursegrades WHERE uniqueID = ? AND subCourseID = ? ORDER BY id DESC LIMIT 1',
        [uniqueID, subCourseID]
      );
      if (!latestRows.length) {
        skipped.push({ ...edit, reason: 'User has no existing attempt on this course to edit' });
        continue;
      }

      await db.query('UPDATE coursegrades SET score = ?, status = ? WHERE id = ?', [score, status, latestRows[0].id]);
      updated++;
    }

    res.json({ success: true, updated, skipped });
  } catch (error) {
    console.error('Error in /api/admin/grades/bulkUpdate:', error);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

// ====================================================================
// Common vs Individual grading MODE, one independent setting per Grades
// Report scope (Level 1 / Level 2+ / Refresher). This sits ALONGSIDE
// subcourses.subCoursePassing (the per-course value an admin can set at
// course creation via uploadExcelAssessment.html/index.html, or edit later
// via courseView.html) rather than replacing or overwriting it:
//
//   mode = 'individual' -> each course is graded at its OWN subCoursePassing
//          (fallback 70 when that particular course never had one set).
//   mode = 'common'     -> every course in that scope is graded at ONE
//          shared commonValue instead, regardless of what subCoursePassing
//          holds for any given course.
//
// Switching modes NEVER writes to subcourses/refresher_subcourses - nothing
// is erased. Flipping from 'common' back to 'individual' instantly restores
// whatever % each course had, because that value was never touched.
//
// Practical courses NEVER go through this mechanism - they always use their
// own subCoursePassing (fallback 70), the same as before this feature
// existed, with no common/individual toggle at all.
//
// The level match for 'l2plus' reuses the same backward-compat rule used
// elsewhere in this file: courses tagged NULL or 'default' count as Level 2
// (pre-dropdown legacy courses).
// ====================================================================
const LEVEL2PLUS_PASSING_MATCH = `
  courseType IN ('assessment', 'scorm')
  AND (subCourseLevel IN ('Level 2', 'Level 3', 'Level 4') OR subCourseLevel IS NULL OR subCourseLevel = 'default')
`;
const LEVEL1_PASSING_MATCH = `courseType IN ('assessment', 'scorm') AND subCourseLevel = 'Level 1'`;
const REFRESHER_PASSING_MATCH = `courseType IN ('assessment', 'scorm')`;

const PASSING_CRITERIA_SCOPES = {
  l1: { table: 'subcourses', match: LEVEL1_PASSING_MATCH },
  l2plus: { table: 'subcourses', match: LEVEL2PLUS_PASSING_MATCH },
  refresher: { table: 'refresher_subcourses', match: REFRESHER_PASSING_MATCH },
};

function passingCriteriaScopeConfig(scope) {
  return PASSING_CRITERIA_SCOPES[scope] || PASSING_CRITERIA_SCOPES.l2plus;
}

function ensurePassingCriteriaSettingsTable() {
  const query = `
    CREATE TABLE IF NOT EXISTS passing_criteria_settings (
      scope VARCHAR(20) NOT NULL,
      mode ENUM('common','individual') NOT NULL DEFAULT 'common',
      commonValue INT NOT NULL DEFAULT 70,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (scope)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `;
  connection.query(query, (error) => {
    if (error) {
      console.error('Error ensuring passing_criteria_settings table:', error);
      return;
    }
    console.log('passing_criteria_settings table is ready');
    seedPassingCriteriaSettingsIfMissing();
  });
}

// First-run only: seed each scope's row from whatever's "already in effect"
// today (the most common non-null subCoursePassing value among that scope's
// courses, or 70 if none has ever been set) - so shipping this feature never
// silently changes anyone's live grading the moment the server restarts.
// mode defaults to 'common' to match that already-in-effect value; admins
// opt into 'individual' explicitly afterward. Never runs again once a
// scope's row exists (an admin's later choice is never overwritten).
function seedPassingCriteriaSettingsIfMissing() {
  Object.entries(PASSING_CRITERIA_SCOPES).forEach(([scope, { table, match }]) => {
    connection.query('SELECT scope FROM passing_criteria_settings WHERE scope = ? LIMIT 1', [scope], (err, rows) => {
      if (err) return console.error(`Error checking passing_criteria_settings seed for ${scope}:`, err);
      if (rows.length) return; // already configured - don't touch an admin's existing choice

      connection.query(
        `SELECT subCoursePassing, COUNT(*) AS cnt FROM ${table} WHERE ${match} AND subCoursePassing IS NOT NULL GROUP BY subCoursePassing ORDER BY cnt DESC, subCoursePassing ASC LIMIT 1`,
        (err2, rows2) => {
          if (err2) return console.error(`Error computing initial commonValue for ${scope}:`, err2);
          const commonValue = rows2.length ? Number(rows2[0].subCoursePassing) : 70;
          connection.query(
            'INSERT INTO passing_criteria_settings (scope, mode, commonValue) VALUES (?, ?, ?)',
            [scope, 'common', commonValue],
            (err3) => { if (err3) console.error(`Error seeding passing_criteria_settings for ${scope}:`, err3); }
          );
        }
      );
    });
  });
}

ensurePassingCriteriaSettingsTable();

async function getPassingCriteriaSettings(scope) {
  const db = connection.promise();
  const [rows] = await db.query('SELECT mode, commonValue FROM passing_criteria_settings WHERE scope = ? LIMIT 1', [scope]);
  if (!rows.length) return { mode: 'common', commonValue: 70 };
  return { mode: rows[0].mode, commonValue: Number(rows[0].commonValue) };
}

// The single source of truth every grading/compute site below should call
// instead of inlining `subCoursePassing == null ? 70 : ...`. Practical
// callers must never use this - they keep their own separate fallback-70
// logic untouched.
async function resolveEffectiveThreshold(scope, subCoursePassing) {
  const settings = await getPassingCriteriaSettings(scope);
  if (settings.mode === 'common') return settings.commonValue;
  return (subCoursePassing === null || subCoursePassing === undefined) ? 70 : Number(subCoursePassing);
}

// Level 1 vs Level 2+ scope is determined purely by subCourseLevel - used by
// write/compute endpoints that serve both levels through the same route.
function scopeForSubcourseLevel(subCourseLevel) {
  return String(subCourseLevel || '').trim() === 'Level 1' ? 'l1' : 'l2plus';
}

// For LIST endpoints (/api/l*/gradesReport, /api/refresher/gradesReport):
// gradesReport.html's client-side computeResult()/certificateEligibility()
// read course.subCoursePassing directly out of the JSON response - so
// rather than touch that client code, when a scope's mode is 'common' we
// override subCoursePassing to the shared commonValue on the way out here.
// Practical/training rows are left completely alone. In 'individual' mode
// this is a no-op passthrough - each course's real stored value ships as-is.
async function applyPassingModeToCourseList(scope, courses) {
  const settings = await getPassingCriteriaSettings(scope);
  if (settings.mode !== 'common') return courses;
  return courses.map(c => (
    (c.courseType === 'assessment' || c.courseType === 'scorm')
      ? { ...c, subCoursePassing: settings.commonValue }
      : c
  ));
}

// GET returns the scope's current { mode, commonValue } so the UI can show
// which mode is active and prefill the common-% input.
app.get('/api/admin/courses/passingCriteria', async (req, res) => {
  const scope = PASSING_CRITERIA_SCOPES[req.query.scope] ? req.query.scope : 'l2plus';
  try {
    const settings = await getPassingCriteriaSettings(scope);
    res.json({ success: true, scope, mode: settings.mode, commonValue: settings.commonValue });
  } catch (error) {
    console.error('Error in GET /api/admin/courses/passingCriteria:', error);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

// Body: { scope: 'l1'|'l2plus'|'refresher', mode: 'common'|'individual', commonValue: number (0-100) }.
// Upserts the scope's settings row only - never touches subcourses /
// refresher_subcourses, so no individual course's saved % is ever lost.
app.post('/api/admin/courses/passingCriteria', express.json(), async (req, res) => {
  const scope = PASSING_CRITERIA_SCOPES[req.body?.scope] ? req.body.scope : 'l2plus';
  const mode = req.body?.mode === 'individual' ? 'individual' : 'common';
  const commonValue = Number(req.body?.commonValue);
  if (Number.isNaN(commonValue) || commonValue < 0 || commonValue > 100) {
    return res.status(400).json({ success: false, error: 'commonValue must be a number between 0 and 100' });
  }

  try {
    const db = connection.promise();
    await db.query(
      `INSERT INTO passing_criteria_settings (scope, mode, commonValue) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE mode = VALUES(mode), commonValue = VALUES(commonValue)`,
      [scope, mode, commonValue]
    );
    res.json({ success: true, scope, mode, commonValue });
  } catch (error) {
    console.error('Error in POST /api/admin/courses/passingCriteria:', error);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

// ====================================================================
// Per-user drill-down for the Grades Report (admin-only, read-only).
// Backs userGradesReport.html: given a uniqueID, lists every course that
// user has at least one graded attempt on - normalized schema only
// (subcourses + coursegrades for assessment+scorm,
// traininggrades for training, practicalevaluations for practical - only
// Submitted practical evaluations show up here, same "Submitted" gate used
// by the main Grades Report), with the latest score/status and a total
// attempt count per course. Does not touch any employee-facing route.
// ====================================================================
app.get('/api/admin/userCourseGrades', async (req, res) => {
  const uniqueID = Number(req.query.uniqueID);
  if (!uniqueID) {
    return res.status(400).json({ success: false, error: 'uniqueID is required' });
  }

  try {
    const db = connection.promise();

    const [userRows] = await db.query(
      'SELECT uniqueID, name, employeeID, uName FROM users WHERE uniqueID = ? LIMIT 1',
      [uniqueID]
    );
    if (!userRows.length) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const [subCourseIDRows] = await db.query(
      `SELECT subCourseID FROM coursegrades WHERE uniqueID = ?
       UNION
       SELECT subCourseID FROM traininggrades WHERE uniqueID = ?
       UNION
       SELECT subCourseID FROM practicalevaluations WHERE uniqueID = ? AND evaluationStatus = 'Submitted'`,
      [uniqueID, uniqueID, uniqueID]
    );
    const subCourseIDs = subCourseIDRows.map(r => r.subCourseID);

    if (!subCourseIDs.length) {
      return res.json({ success: true, user: userRows[0], courses: [] });
    }

    const [courseRows] = await db.query(
      `SELECT subCourseID, subCourseName, courseType, subCourseLevel, subCoursePassing
       FROM subcourses WHERE subCourseID IN (?) ORDER BY subCourseID`,
      [subCourseIDs]
    );

    const courses = await Promise.all(courseRows.map(async (course) => {
      if (course.courseType === 'training') {
        const [rows] = await db.query(
          `SELECT score, status, noOfAttemptss FROM traininggrades
           WHERE uniqueID = ? AND subCourseID = ? ORDER BY id DESC LIMIT 1`,
          [uniqueID, course.subCourseID]
        );
        return {
          subCourseID: course.subCourseID,
          subCourseName: course.subCourseName,
          courseType: course.courseType,
          subCourseLevel: course.subCourseLevel,
          latestScore: rows.length ? rows[0].score : null,
          latestStatus: rows.length ? rows[0].status : null,
          totalAttempts: rows.length ? rows[0].noOfAttemptss : 0
        };
      }
      if (course.courseType === 'practical') {
        // Practical has exactly one evaluation per user/course (not a
        // multi-attempt log) - "attempts" here is really just 1 (Submitted)
        // or 0 (not yet submitted, shouldn't normally appear since the
        // subCourseIDs union above already filters to Submitted only).
        const [rows] = await db.query(
          `SELECT finalPercent, finalResult FROM practicalevaluations
           WHERE uniqueID = ? AND subCourseID = ? AND evaluationStatus = 'Submitted' LIMIT 1`,
          [uniqueID, course.subCourseID]
        );
        return {
          subCourseID: course.subCourseID,
          subCourseName: course.subCourseName,
          courseType: course.courseType,
          subCourseLevel: course.subCourseLevel,
          latestScore: rows.length ? rows[0].finalPercent : null,
          latestStatus: rows.length ? rows[0].finalResult : null,
          totalAttempts: rows.length ? 1 : 0
        };
      }
      // assessment or scorm - coursegrades is the scored attempt log and is
      // the same source the main Grades Report reads. This matters because
      // admin Edit Marks corrects coursegrades, not the raw courseattempts
      // row, so the drilldown must not show stale raw attempt scores.
      const [latestRows] = await db.query(
        `SELECT score, status FROM coursegrades
         WHERE uniqueID = ? AND subCourseID = ? ORDER BY id DESC LIMIT 1`,
        [uniqueID, course.subCourseID]
      );
      const [countRows] = await db.query(
        course.courseType === 'scorm'
          ? `SELECT COUNT(*) AS totalAttempts
             FROM (
               SELECT COALESCE(ca.attemptRemark, NULLIF(cg.courseDate, ''), CONCAT('grade-', cg.id)) AS attemptGroup
               FROM coursegrades cg
               LEFT JOIN courseattempts ca ON ca.attemptID = cg.attemptID
               WHERE cg.uniqueID = ? AND cg.subCourseID = ?
               GROUP BY attemptGroup
             ) groupedAttempts`
          : `SELECT COUNT(*) AS totalAttempts FROM coursegrades
             WHERE uniqueID = ? AND subCourseID = ?`,
        [uniqueID, course.subCourseID]
      );
      const passingThreshold = await resolveEffectiveThreshold(scopeForSubcourseLevel(course.subCourseLevel), course.subCoursePassing);
      return {
        subCourseID: course.subCourseID,
        subCourseName: course.subCourseName,
        courseType: course.courseType,
        subCourseLevel: course.subCourseLevel,
        latestScore: latestRows.length ? latestRows[0].score : null,
        latestStatus: latestRows.length && latestRows[0].score != null
          ? (Number(latestRows[0].score) >= passingThreshold ? 'Pass' : 'Fail')
          : (latestRows.length ? latestRows[0].status : null),
        totalAttempts: countRows[0]?.totalAttempts || 0
      };
    }));

    res.json({ success: true, user: userRows[0], courses });
  } catch (error) {
    console.error('Error in /api/admin/userCourseGrades:', error);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

// ====================================================================
// Attempt-by-attempt history for one user + one course (admin-only,
// read-only). Backs the "View Attempts" drill-down on userGradesReport.html.
// Reads the full coursegrades scored log for assessment/scorm courses, or the
// full traininggrades log for training courses (each row there is already
// one attempt). coursegrades is used instead of raw courseattempts so manual
// admin mark corrections show correctly in the attempt modal.
// ====================================================================
app.get('/api/admin/userCourseAttempts', async (req, res) => {
  const uniqueID = Number(req.query.uniqueID);
  const subCourseID = Number(req.query.subCourseID);
  if (!uniqueID || !subCourseID) {
    return res.status(400).json({ success: false, error: 'uniqueID and subCourseID are required' });
  }

  try {
    const db = connection.promise();

    const [courseRows] = await db.query(
      'SELECT subCourseName, courseType, subCourseLevel, subCoursePassing FROM subcourses WHERE subCourseID = ? LIMIT 1',
      [subCourseID]
    );
    if (!courseRows.length) {
      return res.status(404).json({ success: false, error: 'Course not found' });
    }
    const course = courseRows[0];
    const passingThreshold = await resolveEffectiveThreshold(scopeForSubcourseLevel(course.subCourseLevel), course.subCoursePassing);

    let attempts;
    if (course.courseType === 'training') {
      const [rows] = await db.query(
        `SELECT noOfAttemptss AS attemptNumber, score, status, duration, courseDate, courseTime
         FROM traininggrades WHERE uniqueID = ? AND subCourseID = ? ORDER BY noOfAttemptss DESC`,
        [uniqueID, subCourseID]
      );
      attempts = rows;
    } else if (course.courseType === 'practical') {
      // Practical isn't a multi-attempt log - it's one Submitted evaluation
      // per user/course. Surface it here as a single synthetic "attempt" so
      // the same modal can show its overall score/result/submitted date.
      const [rows] = await db.query(
        `SELECT finalPercent AS score, finalResult AS status, DATE(submittedAt) AS courseDate, TIME(submittedAt) AS courseTime
         FROM practicalevaluations WHERE uniqueID = ? AND subCourseID = ? AND evaluationStatus = 'Submitted' LIMIT 1`,
        [uniqueID, subCourseID]
      );
      attempts = rows.map(r => ({ attemptNumber: 1, score: r.score, status: r.status, duration: null, courseDate: r.courseDate, courseTime: r.courseTime }));
    } else if (course.courseType === 'scorm') {
      const [rows] = await db.query(
        `SELECT cg.noOfAttempts AS attemptNumber, cg.score, cg.status, cg.duration, cg.courseDate, cg.courseTime
         FROM coursegrades cg
         LEFT JOIN courseattempts ca ON ca.attemptID = cg.attemptID
         INNER JOIN (
           SELECT MAX(cg2.id) AS latestGradeID
           FROM coursegrades cg2
           LEFT JOIN courseattempts ca2 ON ca2.attemptID = cg2.attemptID
           WHERE cg2.uniqueID = ? AND cg2.subCourseID = ?
           GROUP BY COALESCE(ca2.attemptRemark, NULLIF(cg2.courseDate, ''), CONCAT('grade-', cg2.id))
         ) latest ON latest.latestGradeID = cg.id
         ORDER BY cg.id ASC`,
        [uniqueID, subCourseID]
      );
      attempts = rows.map((r, index) => ({
        ...r,
        attemptNumber: index + 1,
        status: r.score != null ? (Number(r.score) >= passingThreshold ? 'Pass' : 'Fail') : r.status
      })).reverse();
    } else {
      const [rows] = await db.query(
        `SELECT noOfAttempts AS attemptNumber, score, status, duration, courseDate, courseTime
         FROM coursegrades WHERE uniqueID = ? AND subCourseID = ? ORDER BY noOfAttempts DESC, id DESC`,
        [uniqueID, subCourseID]
      );
      attempts = rows.map(r => ({
        ...r,
        status: r.score != null ? (Number(r.score) >= passingThreshold ? 'Pass' : 'Fail') : r.status
      }));
    }

    res.json({ success: true, subCourseName: course.subCourseName, courseType: course.courseType, attempts });
  } catch (error) {
    console.error('Error in /api/admin/userCourseAttempts:', error);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

// Bulk-acknowledges selected users. Server re-verifies Pass status itself
// (never trusts the client) and is idempotent per user (uniqueID is UNIQUE).
app.post('/api/l1completedusers/bulkAcknowledge', express.json(), (req, res) => {
  const ids = Array.isArray(req.body?.uniqueIDs) ? req.body.uniqueIDs.map(Number).filter(Boolean) : [];
  if (!ids.length) {
    return res.status(400).json({ success: false, error: 'No users selected' });
  }

  // Same dual assessment+training accounting as /api/l1/acknowledge/users -
  // see the comment there for why both coursegrades and traininggrades need
  // to be checked.
  const statusQuery = `
    SELECT
      u.uniqueID,
      sc.subCourseID,
      sc.courseType,
      CASE
        WHEN sc.courseType IN ('assessment', 'scorm') THEN (
          SELECT cg.status FROM coursegrades cg
          WHERE cg.uniqueID = u.uniqueID AND cg.subCourseID = sc.subCourseID
          ORDER BY cg.id DESC LIMIT 1
        )
        WHEN sc.courseType = 'practical' THEN (
          SELECT pe.finalResult FROM practicalevaluations pe
          WHERE pe.uniqueID = u.uniqueID
            AND pe.subCourseID = sc.subCourseID
            AND pe.evaluationStatus = 'Submitted'
          ORDER BY pe.practicalEvalID DESC LIMIT 1
        )
        WHEN sc.courseType = 'training' THEN (
          SELECT tg.status FROM traininggrades tg
          WHERE tg.uniqueID = u.uniqueID AND tg.subCourseID = sc.subCourseID
          ORDER BY tg.id DESC LIMIT 1
        )
      END AS latestStatus
    FROM users u
    JOIN subcourses sc
      ON sc.subCourseLevel = 'Level 1'
      AND sc.courseType IN ('assessment', 'scorm', 'training', 'practical')
      AND (
        sc.subCourseRoles IS NULL
        OR TRIM(sc.subCourseRoles) = ''
        OR FIND_IN_SET(TRIM(u.uRole), sc.subCourseRoles) > 0
      )
    WHERE u.uniqueID IN (?)
  `;

  connection.query(statusQuery, [ids], (sErr, rows) => {
    if (sErr) {
      console.error('Error verifying L1 status for acknowledge:', sErr);
      return res.status(500).json({ success: false, error: 'Database error' });
    }

    const requiredMap = new Map();
    const passedMap = new Map();
    rows.forEach(r => {
      requiredMap.set(r.uniqueID, (requiredMap.get(r.uniqueID) || 0) + 1);
      const isPassed = r.courseType === 'training'
        ? r.latestStatus === 'Completed'
        : r.latestStatus === 'Pass';
      if (isPassed) {
        passedMap.set(r.uniqueID, (passedMap.get(r.uniqueID) || 0) + 1);
      }
    });

    const eligibleIDs = ids.filter(id => {
      const required = requiredMap.get(id) || 0;
      return required > 0 && (passedMap.get(id) || 0) >= required;
    });
    const skipped = ids.length - eligibleIDs.length;

    if (!eligibleIDs.length) {
      return res.json({ success: true, acknowledged: 0, skipped, message: 'None of the selected users have completed every Level 1 course yet.' });
    }

    const adminUniqueID = (req.session && req.session.user && req.session.user.uniqueID) || null;
    const nowDateTime = new Date();
    const nowDate = nowDateTime.toISOString().slice(0, 10);

    const values = eligibleIDs.map(id => [id, nowDate, nowDate, 'Pass', nowDateTime, adminUniqueID]);
    const insertQuery = `
      INSERT INTO l1completedusers (uniqueID, level1StartDate, levelDate, l1Status, acknowledgeDate, acknowledgedBy)
      VALUES ?
      ON DUPLICATE KEY UPDATE
        levelDate = VALUES(levelDate),
        l1Status = VALUES(l1Status),
        acknowledgeDate = VALUES(acknowledgeDate),
        acknowledgedBy = VALUES(acknowledgedBy)
    `;

    connection.query(insertQuery, [values], (insErr) => {
      if (insErr) {
        console.error('Error bulk-acknowledging L1 users:', insErr);
        return res.status(500).json({ success: false, error: 'Database error' });
      }
      res.json({ success: true, acknowledged: eligibleIDs.length, skipped });
    });
  });
});

// Users who are acknowledged for Level 1 and not yet sent on to Level 2+.
// Dashboard summary: one bar-graph's worth of headline numbers - total
// registered (enrolled) users, and how many of them have been acknowledged
// Pass for each of Level 1-4. Distinct uniqueID counts are used for
// Level 2-4 because those tables key on (uniqueID, mCourseID), so a user
// who passed the same level on two different lines would otherwise be
// counted twice.
app.get('/api/admin/dashboardStats', (req, res) => {
  const statsQuery = `
    SELECT
      (SELECT COUNT(*) FROM users) AS totalUsers,
      (SELECT COUNT(*) FROM l1completedusers WHERE l1Status = 'Pass') AS level1Completed,
      (SELECT COUNT(DISTINCT uniqueID) FROM l2completedusers WHERE l2Status = 'Pass') AS level2Completed,
      (SELECT COUNT(DISTINCT uniqueID) FROM l3completedusers WHERE l3Status = 'Pass') AS level3Completed,
      (SELECT COUNT(DISTINCT uniqueID) FROM l4completedusers WHERE l4Status = 'Pass') AS level4Completed
  `;
  connection.query(statsQuery, (error, rows) => {
    if (error) {
      console.error('Error loading dashboard stats:', error);
      return res.status(500).json({ success: false, error: 'Database error' });
    }
    const r = rows[0] || {};
    res.json({
      success: true,
      totalUsers: Number(r.totalUsers) || 0,
      level1Completed: Number(r.level1Completed) || 0,
      level2Completed: Number(r.level2Completed) || 0,
      level3Completed: Number(r.level3Completed) || 0,
      level4Completed: Number(r.level4Completed) || 0
    });
  });
});

// Master level/licence report. Inclusion is intentionally based on Level 1
// completion, not Level 2 enrollment, so a learner remains visible even when
// no department hierarchy has been assigned yet.
app.get('/api/admin/masterTrainingReport', async (req, res) => {
  try {
    const db = connection.promise();
    const [rows] = await db.query(`
      WITH hierarchy_candidates AS (
        SELECT uniqueID, deptID, areaID, mCourseID, stationID, 4 AS priority,
               COALESCE(acknowledgeDate, levelDate) AS assignedAt, id
        FROM l4completedusers WHERE l4Status = 'Pass'
        UNION ALL
        SELECT uniqueID, deptID, areaID, mCourseID, stationID, 3,
               COALESCE(acknowledgeDate, levelDate), id
        FROM l3completedusers WHERE l3Status = 'Pass'
        UNION ALL
        SELECT uniqueID, deptID, areaID, mCourseID, stationID, 2,
               COALESCE(acknowledgeDate, levelDate), id
        FROM l2completedusers WHERE l2Status = 'Pass'
        UNION ALL
        SELECT uniqueID, assignedDeptID, assignedAreaID, assignedMCourseID,
               COALESCE(assignedStationID, 0), 1,
               COALESCE(acknowledgeDate, levelDate), id
        FROM l1completedusers
        WHERE l1Status = 'Pass'
          AND (assignedDeptID IS NOT NULL OR assignedAreaID IS NOT NULL
               OR assignedMCourseID IS NOT NULL OR assignedStationID IS NOT NULL)
        UNION ALL
        SELECT uniqueID, deptID, areaID, mCourseID, stationID, 0,
               NULL, enrollID
        FROM enrollstatus
        WHERE COALESCE(enrollStatus, 'Active') IN ('Active','active','Enrolled','enrolled')
      ), ranked_hierarchy AS (
        SELECT hc.*,
               ROW_NUMBER() OVER (
                 PARTITION BY uniqueID
                 ORDER BY priority DESC, assignedAt DESC, id DESC
               ) AS rn
        FROM hierarchy_candidates hc
      ), level_dates AS (
        SELECT base.uniqueID,
          (SELECT MAX(levelDate) FROM l1completedusers x WHERE x.uniqueID = base.uniqueID AND x.l1Status = 'Pass') AS l1Date,
          (SELECT MAX(levelStartDate) FROM l2completedusers x WHERE x.uniqueID = base.uniqueID AND x.l2Status = 'Pass') AS l2StartDate,
          (SELECT MAX(levelDate) FROM l2completedusers x WHERE x.uniqueID = base.uniqueID AND x.l2Status = 'Pass') AS l2Date,
          (SELECT MAX(levelStartDate) FROM l3completedusers x WHERE x.uniqueID = base.uniqueID AND x.l3Status = 'Pass') AS l3StartDate,
          (SELECT MAX(levelDate) FROM l3completedusers x WHERE x.uniqueID = base.uniqueID AND x.l3Status = 'Pass') AS l3Date,
          (SELECT MAX(levelStartDate) FROM l4completedusers x WHERE x.uniqueID = base.uniqueID AND x.l4Status = 'Pass') AS l4StartDate,
          (SELECT MAX(levelDate) FROM l4completedusers x WHERE x.uniqueID = base.uniqueID AND x.l4Status = 'Pass') AS l4Date
        FROM l1completedusers base
        WHERE base.l1Status = 'Pass'
        GROUP BY base.uniqueID
      ), refresher_dates AS (
        SELECT uniqueID,
          MAX(CASE WHEN levelNumber = 2 THEN refresherCompletedDate END) AS l2RefresherDate,
          MAX(CASE WHEN levelNumber = 3 THEN refresherCompletedDate END) AS l3RefresherDate
        FROM refresher_completion_history
        GROUP BY uniqueID
      )
      SELECT u.uniqueID,
             COALESCE(d.deptName, '') AS department,
             COALESCE(a.areaName, '') AS segment,
             COALESCE(mc.mCourseName, '') AS processName,
             COALESCE(st.stationName, '') AS subProcess,
             COALESCE(u.employeeID, '') AS employeeCode,
             COALESCE(u.name, '') AS employeeName,
             DATE_FORMAT(u.dateOfJoining, '%Y-%m-%d') AS joiningDate,
             DATE_FORMAT(u.dateOfJoining, '%Y-%m-%d') AS l1StartDate,
             DATE_FORMAT(ld.l1Date, '%Y-%m-%d') AS l1EndDate,
             DATE_FORMAT(ld.l2StartDate, '%Y-%m-%d') AS l2StartDate,
             DATE_FORMAT(ld.l2Date, '%Y-%m-%d') AS l2EndDate,
             DATE_FORMAT(rd.l2RefresherDate, '%Y-%m-%d') AS l2RefresherDate,
             DATE_FORMAT(ld.l3StartDate, '%Y-%m-%d') AS l3StartDate,
             DATE_FORMAT(ld.l3Date, '%Y-%m-%d') AS l3EndDate,
             DATE_FORMAT(rd.l3RefresherDate, '%Y-%m-%d') AS l3RefresherDate,
             DATE_FORMAT(ld.l4StartDate, '%Y-%m-%d') AS l4StartDate,
             DATE_FORMAT(ld.l4Date, '%Y-%m-%d') AS l4EndDate
      FROM level_dates ld
      JOIN users u ON u.uniqueID = ld.uniqueID
      LEFT JOIN ranked_hierarchy rh ON rh.uniqueID = u.uniqueID AND rh.rn = 1
      LEFT JOIN departments d ON d.deptID = rh.deptID
      LEFT JOIN areas a ON a.areaID = rh.areaID
      LEFT JOIN mcourses mc ON mc.mCourseID = rh.mCourseID
      LEFT JOIN stations st ON st.stationID = rh.stationID AND rh.stationID <> 0
      LEFT JOIN refresher_dates rd ON rd.uniqueID = u.uniqueID
      ORDER BY u.name, u.employeeID
    `);
    res.json({ success: true, report: rows });
  } catch (error) {
    console.error('Error loading master training report:', error);
    res.status(500).json({ success: false, error: 'Database error', details: error.message });
  }
});

app.get('/api/admin/refresherDashboardStats', async (req, res) => {
  const planMonth = Number(req.query.month) || (new Date().getMonth() + 1);
  const planYear = Number(req.query.year) || new Date().getFullYear();

  if (planMonth < 1 || planMonth > 12 || planYear < 2000) {
    return res.status(400).json({ success: false, error: 'Valid month and year are required' });
  }

  try {
    const db = connection.promise();

    const [[courseStats]] = await db.query(
      `SELECT
         COUNT(*) AS totalCourses,
         SUM(courseType = 'training') AS trainingCourses,
         SUM(courseType = 'assessment') AS assessmentCourses,
         SUM(courseType = 'scorm') AS scormCourses
       FROM refresher_subcourses
       WHERE courseType IN ('assessment', 'training', 'scorm')`
    );

    const [[planStats]] = await db.query(
      `SELECT COUNT(DISTINCT uniqueID) AS plannedUsers
       FROM skillmatrix_refresher_assignments
       WHERE planMonth = ?
         AND planYear = ?
         AND COALESCE(planCode, 'RT') = 'RT'
         AND status IN ('Planned', 'planned')`,
      [planMonth, planYear]
    );

    const [[completionStats]] = await db.query(
      `SELECT COUNT(DISTINCT CONCAT(g.uniqueID, ':', g.subCourseID)) AS completedCourses
       FROM (
         SELECT uniqueID, subCourseID
         FROM refresher_coursegrades
         WHERE status IN ('Pass', 'Completed')
         UNION
         SELECT uniqueID, subCourseID
         FROM refresher_traininggrades
         WHERE status IN ('Pass', 'Completed')
       ) g
       JOIN skillmatrix_refresher_assignments sra
        ON sra.uniqueID = g.uniqueID
        AND sra.planMonth = ?
        AND sra.planYear = ?
        AND COALESCE(sra.planCode, 'RT') = 'RT'
        AND sra.status IN ('Planned', 'planned')`,
      [planMonth, planYear]
    );

    const totalCourses = Number(courseStats.totalCourses) || 0;
    const plannedUsers = Number(planStats.plannedUsers) || 0;
    const totalAssignedCourses = plannedUsers * totalCourses;
    const completedCourses = Number(completionStats.completedCourses) || 0;
    const pendingCourses = Math.max(totalAssignedCourses - completedCourses, 0);
    const completionPercent = totalAssignedCourses
      ? Math.round((completedCourses / totalAssignedCourses) * 100)
      : 0;

    res.json({
      success: true,
      planMonth,
      planYear,
      totalCourses,
      trainingCourses: Number(courseStats.trainingCourses) || 0,
      assessmentCourses: Number(courseStats.assessmentCourses) || 0,
      scormCourses: Number(courseStats.scormCourses) || 0,
      plannedUsers,
      totalAssignedCourses,
      completedCourses,
      pendingCourses,
      completionPercent
    });
  } catch (error) {
    console.error('Error loading refresher dashboard stats:', error);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

// ====================================================================
// DOJO Dashboard (dashboard.html) - ported from the Harman ARS reference
// build's demo-dojo-dashbaord.html, adapted to this schema. Additive only:
// none of the existing /api/admin/dashboardStats or
// /api/admin/refresherDashboardStats endpoints (or the cards/chart/mini
// refresher widget that already consume them on dashboard.html) are
// touched - these are five new, separate endpoints.
//
// Schema differences from the Harman source this was ported from:
//   - users has no preExperience column here, so the "PreviousExperience -
//     wise" demographic slice is replaced with a "Contract - wise" slice
//     (grouped on the free-text `Contract` column instead of forcing fake
//     <=12/>=12-month bins onto data that doesn't exist).
//   - l1completedusers has no deptID - department scoping for Level 1 uses
//     assignedDeptID instead (see /api/l1/eligibleForLevel2 above for the
//     same convention already used elsewhere in this file).
//   - l2/l3/l4completedusers have an explicit l{n}Status column, so "passed
//     this level" is `l{n}Status = 'Pass'`, not just "row exists" like the
//     Harman source assumed.
//   - deletedusers' timestamp column here is `deletedDate`, not `deleteDate`.
// Departments list reuses the existing /api/hierarchy/departments endpoint
// (same {success, departments:[{deptID, deptName}]} shape) rather than
// duplicating a second departments-list route.
// ====================================================================

// GET /api/dojo/dashboard-stats
app.get('/api/dojo/dashboard-stats', async (req, res) => {
  try {
    const db = connection.promise();

    const [[totalRow]] = await db.query(`SELECT COUNT(*) AS total FROM users`);
    const totalStrength = Number(totalRow.total) || 0;

    // Contract-wise (substitute for Harman's PreviousExperience-wise - see
    // note above). Groups on whatever free-text values actually exist.
    const [contractRows] = await db.query(
      `SELECT TRIM(Contract) AS label, COUNT(*) AS count
       FROM users
       WHERE Contract IS NOT NULL AND TRIM(Contract) != ''
       GROUP BY TRIM(Contract)
       ORDER BY count DESC`
    );

    // Education-wise (same LIKE-bucketing approach as the Harman source).
    const [qualificationRows] = await db.query(`
      SELECT
        CASE
          WHEN LOWER(TRIM(qualification)) LIKE '%12%' THEN '12th Pass'
          WHEN LOWER(TRIM(qualification)) LIKE '%graduation%' OR LOWER(TRIM(qualification)) LIKE '%graduate%' OR LOWER(TRIM(qualification)) LIKE '%degree%' THEN 'Graduation'
          WHEN LOWER(TRIM(qualification)) LIKE '%diploma%' THEN 'Diploma'
          ELSE 'Other'
        END AS qualificationGroup,
        COUNT(*) AS count
      FROM users
      WHERE qualification IS NOT NULL AND TRIM(qualification) != ''
      GROUP BY qualificationGroup
    `);
    let pass12th = 0, graduation = 0, diploma = 0, otherQual = 0;
    qualificationRows.forEach(row => {
      if (row.qualificationGroup === '12th Pass') pass12th = row.count;
      else if (row.qualificationGroup === 'Graduation') graduation = row.count;
      else if (row.qualificationGroup === 'Diploma') diploma = row.count;
      else otherQual = row.count;
    });

    // Skill matrix - reuse the exact same Pass-status counts already shown
    // in the summary cards above (/api/admin/dashboardStats), so the two
    // never disagree.
    const [[levelRow]] = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM l1completedusers WHERE l1Status = 'Pass') AS level1,
        (SELECT COUNT(DISTINCT uniqueID) FROM l2completedusers WHERE l2Status = 'Pass') AS level2,
        (SELECT COUNT(DISTINCT uniqueID) FROM l3completedusers WHERE l3Status = 'Pass') AS level3,
        (SELECT COUNT(DISTINCT uniqueID) FROM l4completedusers WHERE l4Status = 'Pass') AS level4
    `);

    // Date of joining - same <=12/>=12 month bands as the Harman source
    // (dateOfJoining is a proper DATE column here, no STR_TO_DATE needed).
    const [[dojLess]] = await db.query(`
      SELECT COUNT(*) AS count FROM users
      WHERE dateOfJoining IS NOT NULL AND DATEDIFF(CURDATE(), dateOfJoining) <= 365
    `);
    const [[dojMore]] = await db.query(`
      SELECT COUNT(*) AS count FROM users
      WHERE dateOfJoining IS NOT NULL AND DATEDIFF(CURDATE(), dateOfJoining) > 365
    `);

    res.json({
      overall: [
        { label: 'Total Strength', value: totalStrength, category: 'Contract - Wise' },
        ...contractRows.map(r => ({ label: r.label, value: Number(r.count), category: 'Contract - Wise' })),
        { label: 'Total Strength', value: totalStrength, category: 'Education - Wise' },
        { label: 'Diploma', value: diploma, category: 'Education - Wise' },
        { label: 'Graduation', value: graduation, category: 'Education - Wise' },
        { label: '12Th Pass', value: pass12th, category: 'Education - Wise' }
      ],
      experience: [
        { label: 'Total Strength', value: totalStrength, category: 'Contract - Wise' },
        ...contractRows.map(r => ({ label: r.label, value: Number(r.count), category: 'Contract - Wise' }))
      ],
      education: [
        { label: 'Total Strength', value: totalStrength, category: 'Education - Wise' },
        { label: '12Th Pass', value: pass12th, category: 'Education - Wise' },
        { label: 'Graduation', value: graduation, category: 'Education - Wise' },
        { label: 'Diploma', value: diploma, category: 'Education - Wise' },
        { label: 'Other', value: otherQual, category: 'Education - Wise' }
      ],
      skillMatrix: [
        { label: 'Total Strength', value: totalStrength, category: 'SKILL - MATRIX' },
        { label: 'LEVEL-1', value: Number(levelRow.level1) || 0, category: 'SKILL - MATRIX' },
        { label: 'LEVEL-2', value: Number(levelRow.level2) || 0, category: 'SKILL - MATRIX' },
        { label: 'LEVEL-3', value: Number(levelRow.level3) || 0, category: 'SKILL - MATRIX' },
        { label: 'LEVEL-4', value: Number(levelRow.level4) || 0, category: 'SKILL - MATRIX' }
      ],
      dateOfJoining: [
        { label: 'Total Strength', value: totalStrength, category: 'DateOfJoining - Wise' },
        { label: '<=12 Months', value: Number(dojLess.count) || 0, category: 'DateOfJoining - Wise' },
        { label: '>=12 Months', value: Number(dojMore.count) || 0, category: 'DateOfJoining - Wise' }
      ]
    });
  } catch (error) {
    console.error('Error fetching DOJO dashboard stats:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard statistics', message: error.message });
  }
});

// GET /api/dojo/scorecard?year= - monthly registered vs deleted users.
app.get('/api/dojo/scorecard', async (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear();
  try {
    const db = connection.promise();
    // registerDate is stored as free-text 'DD/MM/YYYY' (from the
    // toLocaleDateString('en-GB') calls in /save-details and
    // /confirm-bulk-users, e.g. "27/06/2026"), NOT a real DATE/DATETIME
    // column - see database/yyscheafller_aaplication_users.sql. MySQL's
    // implicit string->date conversion assumes YYYY-MM-DD ordering, so
    // MONTH()/YEAR() on the raw column silently returned NULL for every
    // row (the chart always showed 0). STR_TO_DATE with the matching
    // format parses it correctly; rows in some other/legacy format still
    // safely return NULL instead of erroring.
    const [activeResults] = await db.query(
      `SELECT MONTH(STR_TO_DATE(registerDate, '%d/%m/%Y')) AS month, COUNT(*) AS count
       FROM users
       WHERE registerDate IS NOT NULL AND registerDate != ''
         AND STR_TO_DATE(registerDate, '%d/%m/%Y') IS NOT NULL
         AND YEAR(STR_TO_DATE(registerDate, '%d/%m/%Y')) = ?
       GROUP BY MONTH(STR_TO_DATE(registerDate, '%d/%m/%Y'))`,
      [year]
    );
    const [deletedResults] = await db.query(
      `SELECT MONTH(deletedDate) AS month, COUNT(*) AS count
       FROM deletedusers
       WHERE deletedDate IS NOT NULL AND YEAR(deletedDate) = ?
       GROUP BY MONTH(deletedDate)`,
      [year]
    );
    const monthlyData = [];
    for (let month = 1; month <= 12; month++) {
      const activeData = activeResults.find(r => r.month === month);
      const deletedData = deletedResults.find(r => r.month === month);
      monthlyData.push({
        month,
        activeUsers: activeData ? activeData.count : 0,
        deletedUsers: deletedData ? deletedData.count : 0
      });
    }
    res.json(monthlyData);
  } catch (error) {
    console.error('Error fetching DOJO scorecard:', error);
    res.status(500).json({ error: 'Failed to fetch scorecard data' });
  }
});

// GET /api/dojo/department-stats?dept=17
app.get('/api/dojo/department-stats', async (req, res) => {
  try {
    const deptID = parseInt(req.query.dept);
    if (!deptID) return res.status(400).json({ error: 'dept query param required' });
    const db = connection.promise();

    // Total Strength = users actively enrolled to this department at the
    // Line level (same convention as the L2+ Grades Report queries above).
    const [[totalRow]] = await db.query(
      `SELECT COUNT(DISTINCT uniqueID) AS total FROM enrollstatus
       WHERE deptID = ? AND coMCourseID IS NULL AND subCourseID IS NULL
         AND COALESCE(enrollStatus, 'Active') IN ('Active', 'active', 'Enrolled', 'enrolled')`,
      [deptID]
    );
    const totalStrength = Number(totalRow.total) || 0;

    const [[level1Row]] = await db.query(
      `SELECT COUNT(*) AS count FROM l1completedusers WHERE assignedDeptID = ? AND l1Status = 'Pass'`,
      [deptID]
    );
    const [[level2Row]] = await db.query(
      `SELECT COUNT(DISTINCT uniqueID) AS count FROM l2completedusers WHERE deptID = ? AND l2Status = 'Pass'`,
      [deptID]
    );
    const [[level3Row]] = await db.query(
      `SELECT COUNT(DISTINCT uniqueID) AS count FROM l3completedusers WHERE deptID = ? AND l3Status = 'Pass'`,
      [deptID]
    );
    const [[level4Row]] = await db.query(
      `SELECT COUNT(DISTINCT uniqueID) AS count FROM l4completedusers WHERE deptID = ? AND l4Status = 'Pass'`,
      [deptID]
    );

    res.json({
      totalStrength,
      level1: Number(level1Row.count) || 0,
      level2: Number(level2Row.count) || 0,
      level3: Number(level3Row.count) || 0,
      level4: Number(level4Row.count) || 0
    });
  } catch (error) {
    console.error('Error fetching DOJO department stats:', error);
    res.status(500).json({ error: 'Failed to fetch department statistics', message: error.message });
  }
});

// GET /api/dojo/numeric-scorecard?year=2026&month=3
app.get('/api/dojo/numeric-scorecard', async (req, res) => {
  try {
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const month = req.query.month ? parseInt(req.query.month) : null;
    const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    const db = connection.promise();
    const result = [];

    for (let m = 1; m <= 12; m++) {
      const [[joinedRow]] = await db.query(
        `SELECT COUNT(*) AS total FROM users WHERE YEAR(dateOfJoining) = ? AND MONTH(dateOfJoining) = ?`,
        [year, m]
      );
      const joined = Number(joinedRow.total) || 0;

      const [[trainedRow]] = await db.query(
        `SELECT COUNT(*) AS total FROM users u
         INNER JOIN l1completedusers l ON l.uniqueID = u.uniqueID AND l.l1Status = 'Pass'
         WHERE YEAR(u.dateOfJoining) = ? AND MONTH(u.dateOfJoining) = ?`,
        [year, m]
      );
      const trained = Number(trainedRow.total) || 0;
      const discontinued = joined - trained;
      const percentage = joined > 0 ? Number(((trained / joined) * 100).toFixed(1)) : 0;

      result.push({ month: months[m - 1], monthIndex: m, joined, trained, discontinued, percentage });
    }

    res.json({ year, month, data: result });
  } catch (error) {
    console.error('Error fetching DOJO numeric scorecard:', error);
    res.status(500).json({ error: 'Failed to fetch numeric scorecard data' });
  }
});

// GET /api/refresher/training-plan?year= - department x month grid of
// eligible (11-12 months since last refresher/Level-1 completion) vs
// completed (a refresher grade recorded that month).
app.get('/api/refresher/training-plan', async (req, res) => {
  try {
    const year = parseInt(req.query.year || new Date().getFullYear(), 10);
    const db = connection.promise();
    const [depts] = await db.query(`SELECT deptID, deptName FROM departments ORDER BY deptName ASC`);
    if (!depts.length) return res.json({ year, departments: [], months: [] });

    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const result = [];

    for (const dept of depts) {
      const monthData = [];
      for (let m = 1; m <= 12; m++) {
        const d12 = new Date(year, m - 1 - 12, 1);
        const windowStart = `${d12.getFullYear()}-${String(d12.getMonth() + 1).padStart(2, '0')}-01`;
        const d11start = new Date(year, m - 1 - 11, 1);
        const d11end = new Date(year, m - 1 - 11 + 1, 0);
        const windowEnd = `${d11end.getFullYear()}-${String(d11end.getMonth() + 1).padStart(2, '0')}-${String(d11end.getDate()).padStart(2, '0')}`;

        const [[eligibleRow]] = await db.query(`
          SELECT COUNT(DISTINCT u.uniqueID) AS cnt
          FROM users u
          JOIN enrollstatus es ON es.uniqueID = u.uniqueID AND es.deptID = ?
          JOIN l1completedusers l1 ON l1.uniqueID = u.uniqueID AND l1.l1Status = 'Pass'
          WHERE (
            CASE
              WHEN (
                EXISTS (SELECT 1 FROM refresher_traininggrades rtg WHERE rtg.uniqueID = u.uniqueID)
                OR EXISTS (SELECT 1 FROM refresher_coursegrades rcg WHERE rcg.uniqueID = u.uniqueID)
              )
              THEN (
                SELECT GREATEST(
                  IFNULL((SELECT MAX(STR_TO_DATE(courseDate, '%Y-%m-%d')) FROM refresher_traininggrades WHERE uniqueID = u.uniqueID), '1900-01-01'),
                  IFNULL((SELECT MAX(STR_TO_DATE(courseDate, '%Y-%m-%d')) FROM refresher_coursegrades WHERE uniqueID = u.uniqueID), '1900-01-01')
                )
              )
              ELSE l1.levelDate
            END
          ) BETWEEN ? AND ?
        `, [dept.deptID, windowStart, windowEnd]);
        const eligible = Number(eligibleRow?.cnt || 0);

        const [[completedRow]] = await db.query(`
          SELECT COUNT(DISTINCT u.uniqueID) AS cnt
          FROM users u
          JOIN enrollstatus es ON es.uniqueID = u.uniqueID AND es.deptID = ?
          WHERE (
            EXISTS (
              SELECT 1 FROM refresher_traininggrades rtg
              WHERE rtg.uniqueID = u.uniqueID
                AND YEAR(STR_TO_DATE(rtg.courseDate, '%Y-%m-%d')) = ? AND MONTH(STR_TO_DATE(rtg.courseDate, '%Y-%m-%d')) = ?
            )
            OR EXISTS (
              SELECT 1 FROM refresher_coursegrades rcg
              WHERE rcg.uniqueID = u.uniqueID
                AND YEAR(STR_TO_DATE(rcg.courseDate, '%Y-%m-%d')) = ? AND MONTH(STR_TO_DATE(rcg.courseDate, '%Y-%m-%d')) = ?
            )
          )
        `, [dept.deptID, year, m, year, m]);
        const completed = Number(completedRow?.cnt || 0);

        monthData.push({ month: m, eligible, completed });
      }

      const totalEligible = monthData.reduce((s, x) => s + x.eligible, 0);
      const totalCompleted = monthData.reduce((s, x) => s + x.completed, 0);
      result.push({ deptID: dept.deptID, deptName: dept.deptName, months: monthData, totalEligible, totalCompleted });
    }

    const grandMonths = months.map((_, mi) => ({
      month: mi + 1,
      eligible: result.reduce((s, d) => s + d.months[mi].eligible, 0),
      completed: result.reduce((s, d) => s + d.months[mi].completed, 0)
    }));
    const grandTotalEligible = result.reduce((s, d) => s + d.totalEligible, 0);
    const grandTotalCompleted = result.reduce((s, d) => s + d.totalCompleted, 0);

    res.json({
      year, months, departments: result,
      grandTotal: { months: grandMonths, totalEligible: grandTotalEligible, totalCompleted: grandTotalCompleted }
    });
  } catch (error) {
    console.error('Error fetching refresher training plan:', error);
    res.status(500).json({ error: 'Failed to load refresher training plan' });
  }
});

// ====================================================================
// Per-user "1 year since certification" refresher due-date check
// (employee-facing + admin report). This is a THIRD, distinct refresher
// mechanism from the two already in this file:
//   1. Legacy refreshaltrain / courses.RT_Date (dead - references the old
//      `courses` table, which no longer exists in this schema)
//   2. Skill-matrix refresher_subcourses (separate admin-uploaded refresher
//      content library, keyed off its own subCourseID space)
// This one instead re-uses the SAME subcourses/coursegrades/traininggrades
// the employee already passed the first time - "refresher" here just means
// re-attempting the identical course. A course counts as "refreshed" once
// its latest graded attempt happened AFTER that course's level's own
// levelDate (i.e. a genuine re-attempt, not the original pass). Once every
// required course for a level has been refreshed this way, THAT level's
// levelDate is reset to today, pushing its next due date out another year.
//
// CURRENT LEVEL ONLY: a user certified through Level N refreshes Level N.
// Older levels do not run overlapping clocks. Passing every repeated course
// makes the user Qualified, but the clock is reset only when an admin renews
// the certificate and supplies the new license issue date.
//
// One small table (refresher_course_locks) was added, purely for the
// admin "Retrain" gate: the first refresher attempt on a course is always
// open, but if that attempt comes back Fail, the course locks and stays
// locked until an admin explicitly unlocks it via POST
// /api/refresher/unlock (see the Refresher Grades Report admin page). A
// pass never needs admin action.
// ====================================================================
function ensureRefresherCourseLocksTable() {
  connection.query(
    `CREATE TABLE IF NOT EXISTS refresher_course_locks (
      uniqueID INT NOT NULL,
      subCourseID INT NOT NULL,
      locked TINYINT(1) NOT NULL DEFAULT 0,
      lockedAt DATETIME DEFAULT NULL,
      unlockedBy INT DEFAULT NULL,
      unlockedAt DATETIME DEFAULT NULL,
      PRIMARY KEY (uniqueID, subCourseID)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
    (error) => {
      if (error) console.error('Error ensuring refresher_course_locks table:', error);
    }
  );
}
ensureRefresherCourseLocksTable();

// Marks the exact time a due refresher cycle is enabled. Only attempts made
// after this moment count as refresher attempts; original qualification
// attempts cannot be reused when a certificate is backdated.
function ensureRefresherCyclesTable() {
  connection.query(
    `CREATE TABLE IF NOT EXISTS refresher_cycles (
      uniqueID INT NOT NULL,
      levelNumber TINYINT NOT NULL,
      certificationDate DATE NOT NULL,
      dueDate DATE NOT NULL,
      activatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (uniqueID)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
    (error) => {
      if (error) console.error('Error ensuring refresher_cycles table:', error);
    }
  );
}
ensureRefresherCyclesTable();

// Permanent audit used by the master training report. refresher_cycles is an
// active-cycle table and is cleared when a renewed certificate is issued, so
// it cannot by itself answer when an employee completed an earlier refresher.
function ensureRefresherCompletionHistoryTable() {
  connection.query(
    `CREATE TABLE IF NOT EXISTS refresher_completion_history (
      id INT NOT NULL AUTO_INCREMENT,
      uniqueID INT NOT NULL,
      levelNumber TINYINT NOT NULL,
      previousCertificationDate DATE DEFAULT NULL,
      refresherCompletedDate DATE NOT NULL,
      renewedCertificationDate DATE DEFAULT NULL,
      recordedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_refresher_history_user_level (uniqueID, levelNumber)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
    (error) => {
      if (error) console.error('Error ensuring refresher completion history table:', error);
    }
  );
}
ensureRefresherCompletionHistoryTable();

// Every level 1..4 the user has ever been Acknowledged Pass for, ascending,
// each with its own independent levelDate/dueDate/isDue. Level 1 is global;
// Level 2-4 carry their own Dept/Area/Process-Line/Station on the row.
async function resolveAllCertifiedLevels(uniqueID) {
  const db = connection.promise();
  const results = [];
  for (const lvl of [1, 2, 3, 4]) {
    const table = `l${lvl}completedusers`;
    const statusCol = `l${lvl}Status`;
    const extraCols = lvl === 1 ? '' : ', deptID, areaID, mCourseID, stationID';
    const [rows] = await db.query(
      `SELECT
         DATE_FORMAT(levelDate, '%Y-%m-%d') AS levelDate,
         DATE_FORMAT(DATE_ADD(levelDate, INTERVAL 1 YEAR), '%Y-%m-%d') AS dueDate,
         (levelDate IS NOT NULL AND CURDATE() >= DATE_ADD(levelDate, INTERVAL 1 YEAR)) AS isDue
         ${extraCols}
       FROM ${table}
       WHERE uniqueID = ? AND ${statusCol} = 'Pass' AND levelDate IS NOT NULL
       ORDER BY levelDate DESC LIMIT 1`,
      [uniqueID]
    );
    if (rows.length) {
      const r = rows[0];
      results.push({
        level: lvl,
        levelDate: r.levelDate,
        dueDate: r.dueDate,
        isDue: !!r.isDue,
        deptID: lvl === 1 ? null : (r.deptID ?? null),
        areaID: lvl === 1 ? null : (r.areaID ?? null),
        mCourseID: lvl === 1 ? null : (r.mCourseID ?? null),
        stationID: lvl === 1 ? null : (r.stationID ?? null),
      });
    }
  }
  return results;
}

// Required courses for one level (same visibility rule as the employee's
// normal course list - Level 1 is global + role-filtered, Level 2-4 are
// scoped to the specific Dept/Area/Line/Station that level was certified
// under).
async function loadRequiredCoursesForLevel(levelInfo, uniqueID) {
  const db = connection.promise();
  if (levelInfo.level === 1) {
    const [rows] = await db.query(
      `SELECT sc.subCourseID, sc.subCourseName, sc.courseType,
              COALESCE(sc.scormPath, sc.subCoursePath) AS scormPath
       FROM subcourses sc
       WHERE sc.subCourseLevel = 'Level 1'
         AND sc.courseType IN ('assessment', 'scorm', 'training', 'practical')
         AND (
           sc.subCourseRoles IS NULL OR sc.subCourseRoles = ''
           OR FIND_IN_SET((SELECT u.uRole FROM users u WHERE u.uniqueID = ? LIMIT 1), sc.subCourseRoles)
         )`,
      [uniqueID]
    );
    return rows;
  }
  const levelLabelForQuery = `Level ${levelInfo.level}`;
  const levelMatchValues = levelInfo.level === 2 ? [levelLabelForQuery, 'default'] : [levelLabelForQuery];
  const levelMatchClause = levelInfo.level === 2
    ? '(sc.subCourseLevel IS NULL OR sc.subCourseLevel IN (?))'
    : 'sc.subCourseLevel IN (?)';
  const [rows] = await db.query(
    `SELECT sc.subCourseID, sc.subCourseName, sc.courseType,
            COALESCE(sc.scormPath, sc.subCoursePath) AS scormPath
     FROM subcourses sc
     WHERE sc.deptID = ? AND (sc.areaID IS NULL OR sc.areaID = ?) AND (sc.mCourseID IS NULL OR sc.mCourseID = ?)
       AND (sc.stationID = 0 OR ? = 0 OR sc.stationID = ?)
       AND ${levelMatchClause}
       AND sc.courseType IN ('assessment', 'scorm', 'training', 'practical')`,
    [levelInfo.deptID, levelInfo.areaID, levelInfo.mCourseID, levelInfo.stationID, levelInfo.stationID, levelMatchValues]
  );
  return rows;
}

// A failed attempt is locked only when the course belongs to the employee's
// currently certified level and that level's one-year refresher is due.
// Ordinary first-time training attempts are never affected.
async function lockCourseIfCurrentRefresherIsDue(uniqueID, subCourseID) {
  const levels = await resolveAllCertifiedLevels(uniqueID);
  if (!levels.length) return false;
  const current = levels[levels.length - 1];
  if (!current.isDue) return false;
  const courses = await loadRequiredCoursesForLevel(current, uniqueID);
  if (!courses.some(course => Number(course.subCourseID) === Number(subCourseID))) return false;

  await connection.promise().query(
    `INSERT INTO refresher_course_locks (uniqueID, subCourseID, locked, lockedAt)
     VALUES (?, ?, 1, NOW())
     ON DUPLICATE KEY UPDATE locked = 1, lockedAt = NOW(), unlockedBy = NULL, unlockedAt = NULL`,
    [uniqueID, subCourseID]
  );
  return true;
}

// Shared by /api/refresher/my-status (single user, session-driven) and
// /api/admin/refresherStatusReport (all users, admin-driven) so the two
// views can never disagree with each other. Read-only except for the lock
// table, which it keeps in sync with reality every time it's called (locks
// a course the moment it sees a fresh post-due Fail, clears the lock the
// moment it sees a fresh post-due Pass) - cheap, idempotent, and consistent
// with how the rest of this file recomputes everything live on request
// rather than via a background job.
//
// Returns { applicable:false } if the user has never passed any level.
// Otherwise { applicable:true, due, currentLevel, levelLabel,
// levelDate, dueDate, perLevel, courses }. perLevel is one entry per level
// that is CURRENTLY due, each with its own courses[] and allRefreshed flag
// (used by my-status to reset that level's clock independently). courses
// is the flattened union of every due level's courses, each course tagged
// with level/levelLabel, for the popup/report to render as one list.
async function computeUserRefresherStatus(uniqueID) {
  const db = connection.promise();
  const allLevels = await resolveAllCertifiedLevels(uniqueID);
  if (!allLevels.length) return { applicable: false };

  // Client rule: only the employee's highest/current certified level is
  // refreshed. Older certified levels do not run independent overlapping
  // refresher clocks.
  const currentLevelInfo = allLevels[allLevels.length - 1];
  const currentLevel = currentLevelInfo.level;
  const levelLabel = `Level ${currentLevel}`;
  const dueLevelInfos = currentLevelInfo.isDue ? [currentLevelInfo] : [];

  if (!dueLevelInfos.length) {
    return {
      applicable: true, due: false, currentLevel, levelLabel,
      levelDate: currentLevelInfo.levelDate, dueDate: currentLevelInfo.dueDate,
      deptID: currentLevelInfo.deptID, areaID: currentLevelInfo.areaID,
      mCourseID: currentLevelInfo.mCourseID, stationID: currentLevelInfo.stationID,
      perLevel: [], courses: []
    };
  }

  await db.query(
    `INSERT INTO refresher_cycles
       (uniqueID, levelNumber, certificationDate, dueDate, activatedAt)
     VALUES (?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
       activatedAt = IF(
         levelNumber <> VALUES(levelNumber)
         OR certificationDate <> VALUES(certificationDate),
         NOW(),
         activatedAt
       ),
       levelNumber = VALUES(levelNumber),
       certificationDate = VALUES(certificationDate),
       dueDate = VALUES(dueDate)`,
    [uniqueID, currentLevel, currentLevelInfo.levelDate, currentLevelInfo.dueDate]
  );
  const [cycleRows] = await db.query(
    `SELECT DATE_FORMAT(activatedAt, '%Y-%m-%d %H:%i:%s') AS activatedAt
     FROM refresher_cycles WHERE uniqueID = ? LIMIT 1`,
    [uniqueID]
  );
  const cycleActivatedAt = cycleRows[0]?.activatedAt;

  const perLevelRaw = [];
  for (const info of dueLevelInfos) {
    const courseRows = await loadRequiredCoursesForLevel(info, uniqueID);
    perLevelRaw.push({ info, courseRows });
  }

  const allCourseIDs = [].concat(...perLevelRaw.map(p => p.courseRows.map(c => c.subCourseID)));
  const latestByCourse = new Map();
  const lockByCourse = new Map();
  if (allCourseIDs.length) {
    const [gradeRows] = await db.query(
      `SELECT subCourseID, status, courseDate, courseTime,
              CONCAT(LEFT(courseDate, 10), ' ', LEFT(COALESCE(courseTime, '00:00:00'), 8)) AS attemptedAt
       FROM coursegrades
       WHERE uniqueID = ? AND subCourseID IN (?) ORDER BY id DESC`,
      [uniqueID, allCourseIDs]
    );
    const [trainRows] = await db.query(
      `SELECT subCourseID, status, courseDate, courseTime,
              CONCAT(LEFT(courseDate, 10), ' ', LEFT(COALESCE(courseTime, '00:00:00'), 8)) AS attemptedAt
       FROM traininggrades
       WHERE uniqueID = ? AND subCourseID IN (?) ORDER BY id DESC`,
      [uniqueID, allCourseIDs]
    );
    const [practicalRows] = await db.query(
      `SELECT subCourseID, finalResult AS status,
              DATE(submittedAt) AS courseDate,
              TIME(submittedAt) AS courseTime,
              DATE_FORMAT(submittedAt, '%Y-%m-%d %H:%i:%s') AS attemptedAt
       FROM practicalevaluations
       WHERE uniqueID = ? AND subCourseID IN (?) AND evaluationStatus = 'Submitted'
       ORDER BY practicalEvalID DESC`,
      [uniqueID, allCourseIDs]
    );
    [...gradeRows, ...trainRows, ...practicalRows].forEach(r => {
      if (!latestByCourse.has(r.subCourseID)) latestByCourse.set(r.subCourseID, r);
    });
    const [lockRows] = await db.query(
      `SELECT subCourseID, locked,
              DATE_FORMAT(unlockedAt, '%Y-%m-%d %H:%i:%s') AS unlockedAt
       FROM refresher_course_locks WHERE uniqueID = ? AND subCourseID IN (?)`,
      [uniqueID, allCourseIDs]
    );
    lockRows.forEach(r => lockByCourse.set(r.subCourseID, {
      locked: !!r.locked,
      unlockedAt: r.unlockedAt || null
    }));
  }

  const perLevel = [];
  const allCoursesFlat = [];
  for (const { info, courseRows } of perLevelRaw) {
    let levelAllRefreshed = true;
    const levelCourses = [];
    for (const c of courseRows) {
      const latest = latestByCourse.get(c.subCourseID);
      const attemptDate = latest?.courseDate instanceof Date
        ? latest.courseDate.toISOString().slice(0, 10)
        : String(latest?.courseDate || '').slice(0, 10);
      const attemptAt = String(latest?.attemptedAt || '');
      const isPostDueAttempt = !!attemptAt && !!cycleActivatedAt && attemptAt >= cycleActivatedAt;
      const isPassLike = !!latest && (latest.status === 'Pass' || latest.status === 'Completed');
      // "Refreshed" = latest attempt is a pass AND it happened after THIS
      // level's own certification date - a genuine re-attempt, not the
      // original pass.
      const refreshed = isPostDueAttempt && isPassLike;
      const failedSinceDue = isPostDueAttempt && !isPassLike;

      const lockState = lockByCourse.get(c.subCourseID) || { locked: false, unlockedAt: null };
      let locked = lockState.locked;
      const failureWasAlreadyUnlocked = !!(
        failedSinceDue && lockState.unlockedAt && attemptAt && attemptAt <= lockState.unlockedAt
      );
      if (failedSinceDue && !locked && !failureWasAlreadyUnlocked) {
        await db.query(
          `INSERT INTO refresher_course_locks (uniqueID, subCourseID, locked, lockedAt)
           VALUES (?, ?, 1, NOW())
           ON DUPLICATE KEY UPDATE locked = 1, lockedAt = NOW()`,
          [uniqueID, c.subCourseID]
        );
        locked = true;
      } else if (refreshed && locked) {
        await db.query(
          `UPDATE refresher_course_locks SET locked = 0 WHERE uniqueID = ? AND subCourseID = ?`,
          [uniqueID, c.subCourseID]
        );
        locked = false;
      }

      if (!refreshed) levelAllRefreshed = false;
      const courseOut = {
        subCourseID: c.subCourseID,
        courseName: c.subCourseName,
        courseType: c.courseType,
        scormPath: c.scormPath,
        currentStatus: latest ? latest.status : 'No Attempt',
        refreshed,
        locked,
        level: info.level,
        levelLabel: `Level ${info.level}`
      };
      levelCourses.push(courseOut);
      allCoursesFlat.push(courseOut);
    }

    perLevel.push({
      level: info.level,
      levelDate: info.levelDate,
      dueDate: info.dueDate,
      mCourseID: info.mCourseID,
      stationID: info.stationID,
      courses: levelCourses,
      // A level with zero required courses is never "all refreshed" -
      // vacuously true would silently reset a level that was never really
      // checked against anything.
      allRefreshed: levelCourses.length > 0 && levelAllRefreshed
    });
  }

  return {
    applicable: true, due: true, currentLevel, levelLabel,
    levelDate: currentLevelInfo.levelDate, dueDate: currentLevelInfo.dueDate,
    deptID: currentLevelInfo.deptID, areaID: currentLevelInfo.areaID,
    mCourseID: currentLevelInfo.mCourseID, stationID: currentLevelInfo.stationID,
    perLevel, courses: allCoursesFlat
  };
}

app.get('/api/refresher/my-status', async (req, res) => {
  try {
    if (!req.session?.user?.uniqueID) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }
    const uniqueID = req.session.user.uniqueID;
    const db = connection.promise();

    const status = await computeUserRefresherStatus(uniqueID);
    if (!status.applicable) {
      return res.json({ success: true, applicable: false });
    }
    if (!status.due) {
      return res.json({
        success: true, applicable: true, due: false,
        level: status.currentLevel, levelLabel: status.levelLabel,
        levelDate: status.levelDate, dueDate: status.dueDate
      });
    }

    const allRefreshed = status.perLevel.length > 0 && status.perLevel.every(lvl => lvl.allRefreshed);

    res.json({
      success: true, applicable: true, due: true,
      level: status.currentLevel, levelLabel: status.levelLabel,
      levelDate: status.levelDate, dueDate: status.dueDate,
      awaitingCertification: allRefreshed,
      courses: status.courses
    });
  } catch (error) {
    console.error('Error computing refresher status:', error);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

// Admin report: every user who has passed a level, the refresher-cycle
// status for their highest/current certified level, and per-course
// lock state for the Retrain action. Reuses computeUserRefresherStatus so
// this can never drift from what the employee-facing popup shows.
app.get('/api/admin/refresherStatusReport', async (req, res) => {
  try {
    const db = connection.promise();
    const [userRows] = await db.query(`
      SELECT DISTINCT u.uniqueID, u.name, u.employeeID, u.uName, u.isPreviousUser, u.previousCourseIDs
      FROM users u
      WHERE u.uniqueID IN (
        SELECT uniqueID FROM l1completedusers WHERE l1Status = 'Pass'
        UNION SELECT uniqueID FROM l2completedusers WHERE l2Status = 'Pass'
        UNION SELECT uniqueID FROM l3completedusers WHERE l3Status = 'Pass'
        UNION SELECT uniqueID FROM l4completedusers WHERE l4Status = 'Pass'
      )
      ORDER BY u.name
    `);

    const users = [];
    for (const u of userRows) {
      const status = await computeUserRefresherStatus(u.uniqueID);
      if (!status.applicable) continue;

      if (!status.due) {
        users.push({
          uniqueID: u.uniqueID, name: u.name, employeeID: u.employeeID, uName: u.uName,
          level: status.currentLevel, levelLabel: status.levelLabel,
          levelDate: status.levelDate, dueDate: status.dueDate,
          statusLabel: 'Not Due', pendingCourses: []
        });
        continue;
      }

      // An empty combined course list means "nothing matched any due level"
      // (misconfigured roles/hierarchy, or a genuine data issue) - NOT the
      // same thing as "found some, all refreshed". Treating it as Qualified
      // would be a false pass.
      if (!status.courses.length) {
        users.push({
          uniqueID: u.uniqueID, name: u.name, employeeID: u.employeeID, uName: u.uName,
          level: status.currentLevel, levelLabel: status.levelLabel,
          levelDate: status.levelDate, dueDate: status.dueDate,
          deptID: status.deptID, areaID: status.areaID, mCourseID: status.mCourseID, stationID: status.stationID,
          statusLabel: 'No Courses Found', pendingCourses: []
        });
        continue;
      }

      const pending = status.courses.filter(c => !c.refreshed);
      users.push({
        uniqueID: u.uniqueID, name: u.name, employeeID: u.employeeID, uName: u.uName,
        level: status.currentLevel, levelLabel: status.levelLabel,
        levelDate: status.levelDate, dueDate: status.dueDate,
        deptID: status.deptID, areaID: status.areaID, mCourseID: status.mCourseID, stationID: status.stationID,
        statusLabel: pending.length ? 'Disqualified' : 'Qualified',
        pendingCourses: pending.map(c => ({
          subCourseID: c.subCourseID, courseName: c.courseName,
          level: c.level, levelLabel: c.levelLabel,
          locked: c.locked, currentStatus: c.currentStatus
        }))
      });
    }

    res.json({ success: true, users });
  } catch (error) {
    console.error('Error building refresher status report:', error);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

// Admin unlocks one course for one user so they can re-attempt it. A no-op
// (still returns success) if that course wasn't actually locked.
app.post('/api/refresher/unlock', express.json(), async (req, res) => {
  try {
    const { uniqueID, subCourseID } = req.body || {};
    if (!uniqueID || !subCourseID) {
      return res.status(400).json({ success: false, error: 'uniqueID and subCourseID are required' });
    }
    const adminUniqueID = (req.session && req.session.user && req.session.user.uniqueID) || null;
    const db = connection.promise();
    await db.query(
      `UPDATE refresher_course_locks SET locked = 0, unlockedBy = ?, unlockedAt = NOW()
       WHERE uniqueID = ? AND subCourseID = ?`,
      [adminUniqueID, uniqueID, subCourseID]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Error unlocking refresher course:', error);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

app.get('/api/l1/eligibleForLevel2', (req, res) => {
  const query = `
    SELECT u.uniqueID, u.name, u.employeeID, u.uName,
           lcu.acknowledgeDate, lcu.sentForNextLevel, lcu.l2TempStartDate,
           lcu.assignedDeptID, lcu.assignedAreaID, lcu.assignedMCourseID, lcu.assignedStationID,
           d.deptName AS assignedDeptName, a.areaName AS assignedAreaName,
           mc.mCourseName AS assignedMCourseName, st.stationName AS assignedStationName
    FROM l1completedusers lcu
    JOIN users u ON u.uniqueID = lcu.uniqueID
    LEFT JOIN departments d ON d.deptID = lcu.assignedDeptID
    LEFT JOIN areas a ON a.areaID = lcu.assignedAreaID
    LEFT JOIN mcourses mc ON mc.mCourseID = lcu.assignedMCourseID
    LEFT JOIN stations st ON st.stationID = lcu.assignedStationID
    WHERE lcu.l1Status = 'Pass'
    ORDER BY u.name
  `;
  connection.query(query, (error, rows) => {
    if (error) {
      console.error('Error loading Level 2 eligible users:', error);
      return res.status(500).json({ success: false, error: 'Database error' });
    }
    res.json({ success: true, users: rows });
  });
});

// Assigns L1-acknowledged users to a Department/Segment/Process-Line for
// Level 2+ (same enrollstatus mechanism the Enrollment page already uses),
// and marks them as sent-for-next-level in l1completedusers. No day-count /
// duration calculation here (deferred per user's instruction).
app.post('/api/l1/assignLevel2', express.json(), (req, res) => {
  const { deptID, areaID, mCourseID, stationID, users, startDate } = req.body || {};
  const selectedUsers = Array.isArray(users) ? users : [];
  const userUniqueIDs = selectedUsers.map(u => Number(u.uniqueID)).filter(Boolean);

  if (!deptID || !areaID || !mCourseID) {
    return res.status(400).json({ success: false, error: 'deptID, areaID and mCourseID are required' });
  }
  if (!stationID) {
    return res.status(400).json({ success: false, error: 'Station is required' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startDate || ''))) {
    return res.status(400).json({ success: false, error: 'Level 2 Start Date is required' });
  }
  if (!userUniqueIDs.length) {
    return res.status(400).json({ success: false, error: 'No users selected' });
  }

  const ackQuery = `
    SELECT uniqueID, sentForNextLevel, assignedDeptID, assignedAreaID, assignedMCourseID, assignedStationID
    FROM l1completedusers
    WHERE l1Status = 'Pass' AND uniqueID IN (?)
  `;
  connection.query(ackQuery, [userUniqueIDs], (ackErr, ackRows) => {
    if (ackErr) {
      console.error('Error verifying L1 acknowledgement before Level 2 assignment:', ackErr);
      return res.status(500).json({ success: false, error: 'Database error' });
    }

    const eligibleIDs = ackRows.map(r => r.uniqueID);
    if (!eligibleIDs.length) {
      return res.json({ success: true, inserted: 0, skipped: userUniqueIDs.length, message: 'None of the selected users are acknowledged for Level 1 yet.' });
    }

    // One learner receives one Level 2 hierarchy assignment. Do not allow a
    // later request to move or duplicate the learner on another line/station.
    const alreadyAssignedByL1 = new Set(
      ackRows
        .filter(row => row.sentForNextLevel || row.assignedDeptID || row.assignedAreaID || row.assignedMCourseID || row.assignedStationID)
        .map(row => String(row.uniqueID))
    );
    const candidates = eligibleIDs.filter(id => !alreadyAssignedByL1.has(String(id)));
    if (!candidates.length) {
      return res.json({ success: true, inserted: 0, skipped: userUniqueIDs.length, notAcknowledged: userUniqueIDs.length - eligibleIDs.length });
    }

    const checkQuery = `
      SELECT uniqueID FROM enrollstatus
      WHERE coMCourseID IS NULL AND subCourseID IS NULL
        AND uniqueID IN (?)
        AND COALESCE(enrollStatus, 'Active') IN ('Active', 'active', 'Enrolled', 'enrolled')
    `;
    connection.query(checkQuery, [candidates], (checkErr, existingRows) => {
      if (checkErr) {
        console.error('Error checking existing Level 2 enrollment:', checkErr);
        return res.status(500).json({ success: false, error: 'Database error' });
      }

      const alreadyEnrolled = new Set(existingRows.map(row => String(row.uniqueID)));
      const newUniqueIDs = candidates.filter(id => !alreadyEnrolled.has(String(id)));

      const finishWithAssignmentUpdate = () => {
        connection.query(
          `UPDATE l1completedusers
           SET sentForNextLevel = 1, assignedDeptID = ?, assignedAreaID = ?, assignedMCourseID = ?, assignedStationID = ?, l2TempStartDate = ?
           WHERE uniqueID IN (?)`,
          [deptID, areaID, mCourseID, stationID, startDate, newUniqueIDs],
          (updErr) => {
            if (updErr) console.error('Error updating l1completedusers after assignment (non-fatal):', updErr);
            res.json({
              success: true,
              inserted: newUniqueIDs.length,
              skipped: userUniqueIDs.length - newUniqueIDs.length,
              notAcknowledged: userUniqueIDs.length - eligibleIDs.length
            });
          }
        );
      };

      if (!newUniqueIDs.length) {
        return res.json({
          success: true,
          inserted: 0,
          skipped: userUniqueIDs.length,
          notAcknowledged: userUniqueIDs.length - eligibleIDs.length
        });
      }

      const enrollDateText = new Date().toLocaleDateString('en-GB', {});
      const values = newUniqueIDs.map(uniqueID => [
        uniqueID, deptID, areaID, mCourseID, stationID, null, null,
        enrollDateText, startDate, null, 'Active', null, null
      ]);

      connection.query(
        `INSERT INTO enrollstatus
           (uniqueID, deptID, areaID, mCourseID, stationID, coMCourseID, subCourseID, enrollDate, startDate, endDate, enrollStatus, multiSkill, activeTrainingStations)
         VALUES ?`,
        [values],
        (insertErr, insertResult) => {
          if (insertErr) {
            console.error('Error inserting Level 2 enrollment:', insertErr);
            return res.status(500).json({ success: false, error: 'Database error' });
          }

          const adminUniqueID = (req.session && req.session.user && req.session.user.uniqueID) || null;
          const firstInsertID = insertResult.insertId;
          const logRows = newUniqueIDs.map((uniqueID, idx) => [
            firstInsertID + idx, uniqueID, deptID, areaID, mCourseID, null, null,
            'ENROLL_LEVEL2', adminUniqueID, `Level 2+ enrollment via L1 -> Station assignment page (stationID ${stationID})`
          ]);
          connection.query(
            `INSERT INTO enrolllogs
               (enrollID, uniqueID, deptID, areaID, mCourseID, coMCourseID, subCourseID, action, actionBy, remark)
             VALUES ?`,
            [logRows],
            (logErr) => {
              if (logErr) console.error('Error writing enrolllogs for Level 2 assignment (non-fatal):', logErr);
              finishWithAssignmentUpdate();
            }
          );
        }
      );
    });
  });
});

// Correct an incorrect L1 -> Level 2 hierarchy assignment. This removes the
// matching Level 2 enrollment and clears the assignment markers, making the
// learner eligible for selection in the Unassigned tab again.
app.post('/api/l1/unassignLevel2', express.json(), async (req, res) => {
  const uniqueID = Number(req.body?.uniqueID);
  if (!uniqueID) return res.status(400).json({ success: false, error: 'User is required' });

  const db = connection.promise();
  let transactionStarted = false;
  try {
    await db.beginTransaction();
    transactionStarted = true;
    const [assignmentRows] = await db.query(
      `SELECT assignedDeptID, assignedAreaID, assignedMCourseID, assignedStationID
       FROM l1completedusers
       WHERE uniqueID = ? AND l1Status = 'Pass'
       FOR UPDATE`,
      [uniqueID]
    );
    const assignment = assignmentRows[0];
    if (!assignment) {
      await db.rollback();
      return res.status(404).json({ success: false, error: 'Level 1 acknowledged user not found' });
    }
    if (!assignment.assignedDeptID && !assignment.assignedAreaID && !assignment.assignedMCourseID && !assignment.assignedStationID) {
      await db.rollback();
      return res.status(400).json({ success: false, error: 'This user is not currently assigned to Level 2' });
    }

    await db.query(
      `DELETE FROM enrollstatus
       WHERE uniqueID = ? AND deptID = ? AND areaID = ? AND mCourseID = ?
         AND (stationID = ? OR (stationID IS NULL AND ? IS NULL))
         AND coMCourseID IS NULL AND subCourseID IS NULL`,
      [uniqueID, assignment.assignedDeptID, assignment.assignedAreaID, assignment.assignedMCourseID, assignment.assignedStationID, assignment.assignedStationID]
    );
    await db.query(
      `UPDATE l1completedusers
       SET sentForNextLevel = 0, assignedDeptID = NULL, assignedAreaID = NULL,
           assignedMCourseID = NULL, assignedStationID = NULL, l2TempStartDate = NULL
       WHERE uniqueID = ?`,
      [uniqueID]
    );
    await db.commit();
    res.json({ success: true });
  } catch (error) {
    if (transactionStarted) await db.rollback().catch(() => {});
    console.error('Error unassigning Level 2 user:', error);
    res.status(500).json({ success: false, error: 'Could not unassign the user' });
  }
});

// ====================================================================
// Level 2 / 3 / 4 acknowledgement (admin-only). Unlike Level 1 (global,
// every learner), Level 2+ courses live under a Department/Segment/
// Process-Line, so each level's acknowledge page needs that hierarchy
// selection to know which users (enrollstatus) and which subcourses
// (subCourseLevel = 'Level N' under that mCourseID) to check. Level 3 and
// Level 4 additionally require the user to already be acknowledged for the
// previous level under the same Process/Line (sequential gating, same idea
// as L1 ack gating the L1->L2 assignment above). Nothing here touches
// employee-facing pages or the course-attempting/SCORM flow.
// ====================================================================
function registerLevelAcknowledgeRoutes(levelNum) {
  const levelLabel = `Level ${levelNum}`;
  const tableName = `l${levelNum}completedusers`;
  const statusCol = `l${levelNum}Status`;
  // Pre-existing Level 2+ courses uploaded before the Level dropdown existed
  // are tagged subCourseLevel = 'default' (or NULL). Treat those as Level 2
  // so nothing already-uploaded silently disappears from the Level 2 tab.
  const levelMatchValues = levelNum === 2 ? [levelLabel, 'default'] : [levelLabel];
  const levelMatchClause = levelNum === 2
    ? '(sc.subCourseLevel IS NULL OR sc.subCourseLevel IN (?))'
    : 'sc.subCourseLevel IN (?)';
  const skillMatrixRequiredGate = levelNum >= 3
    ? `AND EXISTS (
         SELECT 1 FROM skillmatrix_station_skills sms
         WHERE sms.uniqueID = u.uniqueID
           AND sms.deptID = es.deptID
           AND sms.areaID = es.areaID
           AND sms.mCourseID = es.mCourseID
           AND (sms.stationID = 0 OR es.stationID = 0 OR sms.stationID = es.stationID)
           AND sms.requiredLevel >= ${levelNum}
       )`
    : '';

  // Station match: same "0 OR match" convention used for course visibility
  // everywhere else (stationID = 0 = whole-Line / not station-scoped - either
  // a legacy enrollment made before Stations existed, or one made without
  // picking a station). This USED to be an exact es.stationID = ? match,
  // which meant a whole-Line-enrolled user could complete every course,
  // pass, and still never appear in ANY station's acknowledge pool - fixed
  // so they show up under whichever station the admin is acknowledging from.
  // The sequential Level N-1 -> Level N gate (prevJoin) gets the same
  // relaxation: a whole-Line Level N-1 Pass unlocks every station's Level N,
  // and (since the acknowledge INSERT always stores the station the admin
  // had picked, even for a whole-Line enrollment) a whole-Line current
  // enrollment also accepts a station-specific prior Pass.
  function poolQuery(extraWhere = '') {
    const prevJoin = levelNum >= 3
      ? `JOIN l${levelNum - 1}completedusers prev
           ON prev.uniqueID = u.uniqueID AND prev.mCourseID = es.mCourseID
           AND (prev.stationID = 0 OR es.stationID = 0 OR prev.stationID = es.stationID)
           AND prev.l${levelNum - 1}Status = 'Pass'`
      : '';
    return `
      SELECT DISTINCT u.uniqueID, u.name, u.employeeID, u.uName, u.isPreviousUser, u.previousCourseIDs
      FROM users u
      JOIN enrollstatus es
        ON es.uniqueID = u.uniqueID
        AND es.deptID = ? AND es.areaID = ? AND es.mCourseID = ? AND (es.stationID = 0 OR es.stationID = ?)
        AND es.coMCourseID IS NULL AND es.subCourseID IS NULL
        AND COALESCE(es.enrollStatus, 'Active') IN ('Active', 'active', 'Enrolled', 'enrolled')
      ${prevJoin}
      WHERE 1 = 1
      ${skillMatrixRequiredGate}
      ${extraWhere}
      ORDER BY u.name
    `;
  }

  // Returns every enrolled user's status for this level, computed live from
  // coursegrades/traininggrades, for the chosen Department/Area/Process-Line/Station.
  app.get(`/api/l${levelNum}/acknowledge/users`, (req, res) => {
    const { deptID, areaID, mCourseID, stationID } = req.query;
    if (!deptID || !areaID || !mCourseID || !stationID) {
      return res.status(400).json({ success: false, error: 'deptID, areaID, mCourseID and stationID are required' });
    }

    connection.query(poolQuery(), [deptID, areaID, mCourseID, stationID], (poolErr, poolUsers) => {
      if (poolErr) {
        console.error(`Error loading ${levelLabel} user pool:`, poolErr);
        return res.status(500).json({ success: false, error: 'Database error' });
      }

      const poolIDs = poolUsers.map(u => u.uniqueID);
      if (!poolIDs.length) {
        return res.json({ success: true, users: [], totalLevelCourses: 0 });
      }

      const statusQuery = `
        SELECT
          la.subCourseID,
          la.courseType,
          u.uniqueID,
          CASE
            WHEN la.courseType IN ('assessment', 'scorm') THEN (
              SELECT cg.status FROM coursegrades cg
              WHERE cg.uniqueID = u.uniqueID AND cg.subCourseID = la.subCourseID
              ORDER BY cg.id DESC LIMIT 1
            )
            ELSE (
              SELECT tg.status FROM traininggrades tg
              WHERE tg.uniqueID = u.uniqueID AND tg.subCourseID = la.subCourseID
              ORDER BY tg.id DESC LIMIT 1
            )
          END AS latestStatus
        FROM (SELECT uniqueID FROM users WHERE uniqueID IN (?)) u
        JOIN (
          SELECT sc.subCourseID, sc.courseType FROM subcourses sc
          WHERE (sc.mCourseID = ? OR sc.mCourseID IS NULL) AND (sc.stationID = 0 OR sc.stationID = ?) AND sc.courseType IN ('assessment', 'scorm', 'training') AND ${levelMatchClause}
        ) la ON 1 = 1
      `;
      connection.query(
        statusQuery,
        [poolIDs, mCourseID, stationID, levelMatchValues],
        (sErr, statusRows) => {
          if (sErr) {
            console.error(`Error loading ${levelLabel} status:`, sErr);
            return res.status(500).json({ success: false, error: 'Database error' });
          }

          connection.query(`SELECT uniqueID, acknowledgeDate, ${statusCol} FROM ${tableName} WHERE mCourseID = ? AND stationID = ?`, [mCourseID, stationID], (aErr, ackRows) => {
            if (aErr) {
              console.error(`Error loading ${tableName}:`, aErr);
              return res.status(500).json({ success: false, error: 'Database error' });
            }

            const totalCount = new Set(statusRows.map(r => r.subCourseID)).size;
            const passedMap = new Map();
            const attemptedMap = new Map();
            statusRows.forEach(r => {
              if (r.latestStatus) {
                attemptedMap.set(r.uniqueID, (attemptedMap.get(r.uniqueID) || 0) + 1);
                const isPassed = (r.courseType === 'assessment' || r.courseType === 'scorm') ? r.latestStatus === 'Pass' : r.latestStatus === 'Completed';
                if (isPassed) passedMap.set(r.uniqueID, (passedMap.get(r.uniqueID) || 0) + 1);
              }
            });
            const ackMap = new Map(ackRows.map(a => [a.uniqueID, a]));

            const result = poolUsers
              .map(u => {
                const passed = passedMap.get(u.uniqueID) || 0;
                const attempted = attemptedMap.get(u.uniqueID) || 0;
                let levelStatus = 'No Attempt';
                if (totalCount > 0) {
                  if (passed >= totalCount) levelStatus = 'Pass';
                  else if (attempted > 0) levelStatus = 'Fail';
                }
                const ack = ackMap.get(u.uniqueID);
                return {
                  uniqueID: u.uniqueID,
                  name: u.name,
                  employeeID: u.employeeID,
                  uName: u.uName,
                  totalLevelCourses: totalCount,
                  passedLevelCourses: passed,
                  levelStatus: u.isPreviousUser ? 'Previous User' : levelStatus,
                  acknowledged: !!ack,
                  acknowledgeDate: ack ? ack.acknowledgeDate : null,
                  isPreviousUser: !!u.isPreviousUser
                };
              })
              .filter(r => r.totalLevelCourses > 0 && (r.levelStatus !== 'No Attempt' || r.acknowledged));

            res.json({ success: true, users: result, totalLevelCourses: totalCount });
          });
        }
      );
    });
  });

  // Bulk-acknowledges selected users for this level/Process-Line. Re-verifies
  // pool membership + Pass status server-side (never trusts the client).
  app.post(`/api/l${levelNum}completedusers/bulkAcknowledge`, express.json(), (req, res) => {
    const { deptID, areaID, mCourseID, stationID } = req.body || {};
    const ids = Array.isArray(req.body?.uniqueIDs) ? req.body.uniqueIDs.map(Number).filter(Boolean) : [];
    if (!deptID || !areaID || !mCourseID || !stationID) {
      return res.status(400).json({ success: false, error: 'deptID, areaID, mCourseID and stationID are required' });
    }
    if (!ids.length) {
      return res.status(400).json({ success: false, error: 'No users selected' });
    }

    connection.query(poolQuery('AND u.uniqueID IN (?)'), [deptID, areaID, mCourseID, stationID, ids], (poolErr, poolUsers) => {
      if (poolErr) {
        console.error(`Error verifying ${levelLabel} pool for acknowledge:`, poolErr);
        return res.status(500).json({ success: false, error: 'Database error' });
      }

      const poolIDs = poolUsers.map(u => u.uniqueID);
      if (!poolIDs.length) {
        return res.json({ success: true, acknowledged: 0, skipped: ids.length, message: `None of the selected users are eligible for ${levelLabel} acknowledgement yet.` });
      }

      const statusQuery = `
        SELECT la.subCourseID, la.courseType, u.uniqueID,
          CASE
            WHEN la.courseType IN ('assessment', 'scorm') THEN (
              SELECT cg.status FROM coursegrades cg
              WHERE cg.uniqueID = u.uniqueID AND cg.subCourseID = la.subCourseID
              ORDER BY cg.id DESC LIMIT 1
            )
            ELSE (
              SELECT tg.status FROM traininggrades tg
              WHERE tg.uniqueID = u.uniqueID AND tg.subCourseID = la.subCourseID
              ORDER BY tg.id DESC LIMIT 1
            )
          END AS latestStatus
        FROM (SELECT uniqueID FROM users WHERE uniqueID IN (?)) u
        JOIN (
          SELECT sc.subCourseID, sc.courseType FROM subcourses sc
          WHERE (sc.mCourseID = ? OR sc.mCourseID IS NULL) AND (sc.stationID = 0 OR sc.stationID = ?) AND sc.courseType IN ('assessment', 'scorm', 'training') AND ${levelMatchClause}
        ) la ON 1 = 1
      `;
      connection.query(statusQuery, [poolIDs, mCourseID, stationID, levelMatchValues], (sErr, rows) => {
        if (sErr) {
          console.error(`Error verifying ${levelLabel} status for acknowledge:`, sErr);
          return res.status(500).json({ success: false, error: 'Database error' });
        }

        const totalCount = new Set(rows.map(r => r.subCourseID)).size;
        const passedMap = new Map();
        rows.forEach(r => {
          const isPassed = (r.courseType === 'assessment' || r.courseType === 'scorm') ? r.latestStatus === 'Pass' : r.latestStatus === 'Completed';
          if (isPassed) passedMap.set(r.uniqueID, (passedMap.get(r.uniqueID) || 0) + 1);
        });

        const eligibleIDs = poolIDs.filter(id => totalCount > 0 && (passedMap.get(id) || 0) >= totalCount);
        const skipped = ids.length - eligibleIDs.length;

        if (!eligibleIDs.length) {
          return res.json({ success: true, acknowledged: 0, skipped, message: `None of the selected users have completed every ${levelLabel} course yet.` });
        }

        const adminUniqueID = (req.session && req.session.user && req.session.user.uniqueID) || null;
        const nowDateTime = new Date();
        const nowDate = nowDateTime.toISOString().slice(0, 10);
        const values = eligibleIDs.map(id => [id, deptID, areaID, mCourseID, stationID, nowDate, nowDate, 'Pass', nowDateTime, adminUniqueID]);

        const insertQuery = `
          INSERT INTO ${tableName} (uniqueID, deptID, areaID, mCourseID, stationID, levelStartDate, levelDate, ${statusCol}, acknowledgeDate, acknowledgedBy)
          VALUES ?
          ON DUPLICATE KEY UPDATE
            levelDate = VALUES(levelDate),
            ${statusCol} = VALUES(${statusCol}),
            acknowledgeDate = VALUES(acknowledgeDate),
            acknowledgedBy = VALUES(acknowledgedBy)
        `;
        connection.query(insertQuery, [values], (insErr) => {
          if (insErr) {
            console.error(`Error bulk-acknowledging ${levelLabel} users:`, insErr);
            return res.status(500).json({ success: false, error: 'Database error' });
          }
          res.json({ success: true, acknowledged: eligibleIDs.length, skipped });
        });
      });
    });
  });
}

registerLevelAcknowledgeRoutes(2);
registerLevelAcknowledgeRoutes(3);
registerLevelAcknowledgeRoutes(4);

// ====================================================================
// Practical Evaluation module (admin-only).
//
// This implements the standardized Schaeffler "Operator On the Job Training
// Observance & Level 2 Evaluation - New Joinees" form (doc FMT/DOJO/18/R00)
// as a fixed checklist (8 categories / 15 checkpoints, 0-2 scale, 2 pts max
// each = 30 pts/day) scored across 6 OJT days (day10-day15) plus 2 follow-up
// monitoring weeks (wk3, wk4). The same fixed checklist is used for every
// Practical course, both Level 1 and Level 2+ - only the course list/filter
// and eligible-user pool differ between the two tabs on practicalEvaluation.html.
//
// Nothing here touches employee login, course-attempting, or SCORM-delivery
// code/tables. This is a brand new admin-only module: new tables
// (practicalevaluations / practicalevaluationscores), new courseType
// ('practical') value on subcourses, new routes, new admin pages only.
// ====================================================================

const PRACTICAL_CHECKLIST = [
  { checkpointNo: 1, category: 'Parts Handling', criteria: 'Check method of handling parts (Ok, Reject) Identification and traceability' },
  { checkpointNo: 2, category: 'Work Standards', criteria: 'Check understanding and adherence of Vsop' },
  { checkpointNo: 3, category: 'Work Standards', criteria: 'Check operator for updating check sheet, work order' },
  { checkpointNo: 4, category: 'Work Standards', criteria: 'Using stop call wait process in case of abnormal condition' },
  { checkpointNo: 5, category: 'Product', criteria: 'Check understanding of running product, child parts, process flow' },
  { checkpointNo: 6, category: 'Production/Process', criteria: 'Check following FIFO, bin standard for soft & hard material' },
  { checkpointNo: 7, category: 'Production/Process', criteria: 'Confirm machine / process cycle time as per standard' },
  { checkpointNo: 8, category: 'Quality', criteria: 'Check input & output quality of parts as per specification' },
  { checkpointNo: 9, category: 'Quality', criteria: 'Check awareness and updation of production release & control card as per std' },
  { checkpointNo: 10, category: 'Quality', criteria: 'Check for handling NG parts as per standard & use of red bin' },
  { checkpointNo: 11, category: 'Awareness', criteria: 'Check knowhow about poka yoke and cross check (if available)' },
  { checkpointNo: 12, category: 'Awareness', criteria: 'Check operator aware of purpose of work & impact to customer' },
  { checkpointNo: 13, category: 'Safety', criteria: 'Check using PPE as per process requirement' },
  { checkpointNo: 14, category: 'Safety', criteria: 'Following machine safety instructions' },
  { checkpointNo: 15, category: 'Discipline', criteria: 'Work licence / ID / Uniform / safety shoes' },
];

const PRACTICAL_DAY_COLUMNS = [
  { code: 'day10', label: 'Day 10', group: 'observation' },
  { code: 'day11', label: 'Day 11', group: 'observation' },
  { code: 'day12', label: 'Day 12', group: 'observation' },
  { code: 'day13', label: 'Day 13', group: 'observation' },
  { code: 'day14', label: 'Day 14', group: 'observation' },
  { code: 'day15', label: 'Day 15', group: 'observation' },
  { code: 'wk3', label: 'Week 3', group: 'monitoring' },
  { code: 'wk4', label: 'Week 4', group: 'monitoring' },
];
const PRACTICAL_DAY_CODES = PRACTICAL_DAY_COLUMNS.map(d => d.code);
const PRACTICAL_PASS_PERCENT = 70;
const PRACTICAL_MAX_PER_CHECKPOINT = 2;

app.get('/api/practical/checklist', (req, res) => {
  res.json({ success: true, checklist: PRACTICAL_CHECKLIST, dayColumns: PRACTICAL_DAY_COLUMNS, passPercent: PRACTICAL_PASS_PERCENT });
});

// Creates a new Practical subcourse. Level 1 practicals are standalone (no
// hierarchy, visible to every learner - same convention as other Level 1
// course types). Level 2+ practicals are tied to a Department/Area/Process-Line,
// same as other Level 2+ course types, via mCourseID -> default comaincourses row.
app.post('/api/practical/createCourse', express.json(), (req, res) => {
  const { courseName, level, deptID, areaID, mCourseID, stationID, description, isCommon, subCourseRoles } = req.body || {};
  if (!courseName || !level) {
    return res.status(400).json({ success: false, error: 'courseName and level are required' });
  }
  const isLevel1 = level === 'Level 1';
  // Common Level 2/3/4 practical: no Department/Area/Process-Line at all,
  // visible to any user with an active Level 2+ enrollment anywhere.
  const isCommonCourse = !isLevel1 && isCommon === true;
  const isStandalone = isLevel1 || isCommonCourse;
  if (!isStandalone && (!deptID || !areaID || !mCourseID)) {
    return res.status(400).json({ success: false, error: 'deptID, areaID and mCourseID are required for Level 2 and above' });
  }
  // stationID 0 = whole-Line (matches the same convention used everywhere
  // else - existing/legacy courses without a station keep working).
  const resolvedStationID = isStandalone ? 0 : (Number(stationID) || 0);

  // Only meaningful for standalone Level 1 courses (see /getViewscormCourseList) -
  // harmless to store for other levels since nothing else reads it there yet.
  const normalizedRoles = normalizeSubCourseRoles(subCourseRoles);

  const insertWithLine = (line, coMCourseID) => {
    const query = `
      INSERT INTO subcourses
        (deptID, areaID, mCourseID, stationID, coMCourseID, subCourseName, subCourseDescription, subCourseDate,
         subCourseLevel, subCoursePassing, courseType, subCourseRoles)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURDATE(), ?, ?, 'practical', ?)
    `;
    connection.query(
      query,
      [line.deptID, line.areaID, line.mCourseID, resolvedStationID, coMCourseID, courseName, description || null, level, PRACTICAL_PASS_PERCENT, normalizedRoles],
      (insertError, result) => {
        if (insertError) {
          console.error('Error creating practical course:', insertError);
          return res.status(500).json({ success: false, error: 'Database error' });
        }
        res.json({ success: true, subCourseID: result.insertId });
      }
    );
  };

  if (isStandalone) {
    return insertWithLine({ deptID: null, areaID: null, mCourseID: null }, null);
  }

  const lineQuery = `
    SELECT m.mCourseID, m.deptID, m.areaID, co.coMCourseID
    FROM mcourses m
    LEFT JOIN comaincourses co ON co.mCourseID = m.mCourseID AND co.isDefaultForLine = 1
    WHERE m.mCourseID = ?
    ORDER BY co.coMCourseID
    LIMIT 1
  `;
  connection.query(lineQuery, [mCourseID], (lineError, lineRows) => {
    if (lineError) {
      console.error('Error resolving line for practical course:', lineError);
      return res.status(500).json({ success: false, error: 'Database error' });
    }
    if (!lineRows.length) {
      return res.status(404).json({ success: false, error: 'Process/Line not found' });
    }
    insertWithLine(lineRows[0], lineRows[0].coMCourseID || null);
  });
});

// Lists Practical courses. ?level=Level%201 for the Level 1 tab, or
// ?level=Level2Plus&mCourseID=NN for the Level 2+ tab (courses under the
// chosen Process/Line, any of Level 2/3/4).
app.get('/api/practical/courses', (req, res) => {
  const { level, mCourseID } = req.query;
  if (level === 'Level 1') {
    return connection.query(
      `SELECT subCourseID, subCourseName, subCourseLevel, subCourseDate, subCoursePassing
       FROM subcourses WHERE courseType = 'practical' AND subCourseLevel = 'Level 1' ORDER BY subCourseID DESC`,
      (error, rows) => {
        if (error) {
          console.error('Error listing Level 1 practical courses:', error);
          return res.status(500).json({ success: false, error: 'Database error' });
        }
        res.json({ success: true, courses: rows });
      }
    );
  }

  if (level === 'Level2Plus') {
    if (!mCourseID) {
      return res.status(400).json({ success: false, error: 'mCourseID is required' });
    }
    return connection.query(
      `SELECT subCourseID, subCourseName, subCourseLevel, subCourseDate, subCoursePassing
       FROM subcourses
       WHERE courseType = 'practical' AND subCourseLevel IN ('Level 2','Level 3','Level 4') AND mCourseID = ?
       ORDER BY subCourseID DESC`,
      [mCourseID],
      (error, rows) => {
        if (error) {
          console.error('Error listing Level 2+ practical courses:', error);
          return res.status(500).json({ success: false, error: 'Database error' });
        }
        res.json({ success: true, courses: rows });
      }
    );
  }

  if (level === 'Common') {
    const { courseLevel } = req.query;
    if (!courseLevel || !['Level 2', 'Level 3', 'Level 4'].includes(courseLevel)) {
      return res.status(400).json({ success: false, error: "courseLevel must be 'Level 2', 'Level 3' or 'Level 4'" });
    }
    return connection.query(
      `SELECT subCourseID, subCourseName, subCourseLevel, subCourseDate, subCoursePassing
       FROM subcourses
       WHERE courseType = 'practical' AND mCourseID IS NULL AND subCourseLevel = ?
       ORDER BY subCourseID DESC`,
      [courseLevel],
      (error, rows) => {
        if (error) {
          console.error('Error listing Common practical courses:', error);
          return res.status(500).json({ success: false, error: 'Database error' });
        }
        res.json({ success: true, courses: rows });
      }
    );
  }

  return res.status(400).json({ success: false, error: "level must be 'Level 1', 'Level2Plus' or 'Common'" });
});

// Eligible-users pool for a Practical course. Level 1 = every user (same as
// other Level 1 admin lists). Level 2+ = every user with a broad enrollstatus
// grant on that course's Dept/Area/Process-Line (same pool query used by
// registerLevelAcknowledgeRoutes above). Either way, a user who already has a
// Submitted evaluation for this course is excluded - they only reappear if an
// admin needs to look them up directly, not on this "to do" list.
app.get('/api/practical/eligibleUsers', (req, res) => {
  const { subCourseID } = req.query;
  if (!subCourseID) {
    return res.status(400).json({ success: false, error: 'subCourseID is required' });
  }

  connection.query(
    `SELECT subCourseID, subCourseName, subCourseLevel, subCourseRoles, deptID, areaID, mCourseID FROM subcourses WHERE subCourseID = ? AND courseType = 'practical' LIMIT 1`,
    [subCourseID],
    (courseErr, courseRows) => {
      if (courseErr) {
        console.error('Error loading practical course:', courseErr);
        return res.status(500).json({ success: false, error: 'Database error' });
      }
      if (!courseRows.length) {
        return res.status(404).json({ success: false, error: 'Practical course not found' });
      }
      const course = courseRows[0];

      const finish = (poolQuery, poolParams) => {
        connection.query(poolQuery, poolParams, (poolErr, poolUsers) => {
          if (poolErr) {
            console.error('Error loading eligible-user pool for practical course:', poolErr);
            return res.status(500).json({ success: false, error: 'Database error' });
          }
          connection.query(
            `SELECT pe.uniqueID, pe.evaluationStatus, pe.result, pe.overallPercent
             FROM practicalevaluations pe WHERE pe.subCourseID = ?`,
            [subCourseID],
            async (evalErr, evalRows) => {
              if (evalErr) {
                console.error('Error loading practical evaluations for eligibility filter:', evalErr);
                return res.status(500).json({ success: false, error: 'Database error' });
              }
              const evalMap = new Map(evalRows.map(e => [Number(e.uniqueID), e]));
              const users = [];
              for (const u of poolUsers) {
                const existing = evalMap.get(Number(u.uniqueID));
                let needsRefresherEvaluation = false;
                if (existing && existing.evaluationStatus === 'Submitted') {
                  try {
                    const refresher = await computeUserRefresherStatus(u.uniqueID);
                    const refresherCourse = (refresher.courses || [])
                      .find(c => Number(c.subCourseID) === Number(subCourseID));
                    needsRefresherEvaluation = !!refresherCourse && !refresherCourse.refreshed;
                  } catch (statusError) {
                    console.error(`Error checking practical refresher eligibility for user ${u.uniqueID}:`, statusError);
                  }
                }
                if (existing && existing.evaluationStatus === 'Submitted' && !needsRefresherEvaluation) continue;
                users.push((() => {
                  const existing = evalMap.get(Number(u.uniqueID));
                  return {
                    uniqueID: u.uniqueID,
                    name: u.name,
                    employeeID: u.employeeID,
                    uName: u.uName,
                    hasDraft: !!existing && existing.evaluationStatus !== 'Submitted',
                    refresherRequired: needsRefresherEvaluation
                  };
                })());
              }
              res.json({ success: true, course, users });
            }
          );
        });
      };

      if (course.subCourseLevel === 'Level 1') {
        return finish(
          `SELECT uniqueID, name, employeeID, uName
           FROM users
           WHERE ? IS NULL OR ? = '' OR FIND_IN_SET(uRole, ?)
           ORDER BY name`,
          [course.subCourseRoles, course.subCourseRoles, course.subCourseRoles]
        );
      }

      // Common Level 2/3/4 practical (no Dept/Area/Process-Line at all): pool is
      // any user with at least one active Level 2+ enrollment anywhere, matching
      // the same "common course" visibility rule used in getViewscormCourseList.
      if (!course.mCourseID) {
        const commonPoolQuery = `
          SELECT DISTINCT u.uniqueID, u.name, u.employeeID, u.uName
          FROM users u
          JOIN enrollstatus es
            ON es.uniqueID = u.uniqueID
            AND es.coMCourseID IS NULL AND es.subCourseID IS NULL
            AND COALESCE(es.enrollStatus, 'Active') IN ('Active', 'active', 'Enrolled', 'enrolled')
          ORDER BY u.name
        `;
        return finish(commonPoolQuery, []);
      }

      const poolQuery = `
        SELECT DISTINCT u.uniqueID, u.name, u.employeeID, u.uName, u.isPreviousUser, u.previousCourseIDs
        FROM users u
        JOIN enrollstatus es
          ON es.uniqueID = u.uniqueID
          AND es.deptID = ? AND es.areaID = ? AND es.mCourseID = ?
          AND es.coMCourseID IS NULL AND es.subCourseID IS NULL
          AND COALESCE(es.enrollStatus, 'Active') IN ('Active', 'active', 'Enrolled', 'enrolled')
        ORDER BY u.name
      `;
      finish(poolQuery, [course.deptID, course.areaID, course.mCourseID]);
    }
  );
});

// Loads one user's evaluation for one Practical course - existing header +
// scores (if any), plus the checklist/day columns and basic user/course info
// so the form page can render fully from a single call.
app.get('/api/practical/evaluation', (req, res) => {
  const { subCourseID, uniqueID } = req.query;
  if (!subCourseID || !uniqueID) {
    return res.status(400).json({ success: false, error: 'subCourseID and uniqueID are required' });
  }

  connection.query(
    `SELECT sc.subCourseID, sc.subCourseName, sc.subCourseLevel, sc.subCoursePassing, d.deptName, a.areaName, m.mCourseName
     FROM subcourses sc
     LEFT JOIN departments d ON d.deptID = sc.deptID
     LEFT JOIN areas a ON a.areaID = sc.areaID
     LEFT JOIN mcourses m ON m.mCourseID = sc.mCourseID
     WHERE sc.subCourseID = ? AND sc.courseType = 'practical' LIMIT 1`,
    [subCourseID],
    (courseErr, courseRows) => {
      if (courseErr) {
        console.error('Error loading practical course for evaluation:', courseErr);
        return res.status(500).json({ success: false, error: 'Database error' });
      }
      if (!courseRows.length) {
        return res.status(404).json({ success: false, error: 'Practical course not found' });
      }
      // Admin-configurable per-course passing % (subcourses.subCoursePassing,
      // editable via courseView.html) - falls back to the historical 70%
      // default only when the column is unset for this course.
      const coursePassPercent = courseRows[0].subCoursePassing == null
        ? PRACTICAL_PASS_PERCENT
        : Number(courseRows[0].subCoursePassing);

      connection.query(
        `SELECT uniqueID, name, employeeID, uName, department, dateOfJoining FROM users WHERE uniqueID = ? LIMIT 1`,
        [uniqueID],
        (userErr, userRows) => {
          if (userErr) {
            console.error('Error loading user for evaluation:', userErr);
            return res.status(500).json({ success: false, error: 'Database error' });
          }
          if (!userRows.length) {
            return res.status(404).json({ success: false, error: 'User not found' });
          }

          connection.query(
            `SELECT * FROM practicalevaluations WHERE subCourseID = ? AND uniqueID = ? LIMIT 1`,
            [subCourseID, uniqueID],
            (evalErr, evalRows) => {
              if (evalErr) {
                console.error('Error loading practical evaluation header:', evalErr);
                return res.status(500).json({ success: false, error: 'Database error' });
              }
              const evaluation = evalRows[0] || null;
              if (!evaluation) {
                return res.json({
                  success: true, course: courseRows[0], user: userRows[0], evaluation: null, scores: [],
                  checklist: PRACTICAL_CHECKLIST, dayColumns: PRACTICAL_DAY_COLUMNS, passPercent: coursePassPercent,
                });
              }
              connection.query(
                `SELECT checkpointNo, dayCode, score FROM practicalevaluationscores WHERE practicalEvalID = ?`,
                [evaluation.practicalEvalID],
                (scoreErr, scoreRows) => {
                  if (scoreErr) {
                    console.error('Error loading practical evaluation scores:', scoreErr);
                    return res.status(500).json({ success: false, error: 'Database error' });
                  }
                  res.json({
                    success: true, course: courseRows[0], user: userRows[0], evaluation, scores: scoreRows,
                    checklist: PRACTICAL_CHECKLIST, dayColumns: PRACTICAL_DAY_COLUMNS, passPercent: coursePassPercent,
                  });
                }
              );
            }
          );
        }
      );
    }
  );
});

// Saves (Draft) or finalizes (Submitted) one user's evaluation for one
// Practical course. Body: { subCourseID, uniqueID, action: 'Draft'|'Submitted',
// employeeCode, dateOfJoining, deptSegmentLine, mcProcess, ojtStartDate,
// ojtEndDate, scores: [{ checkpointNo, dayCode, score }] } where score is
// 0, 1, 2, or null (null clears/marks that cell not-applicable - it is simply
// not counted in that column's denominator, per the form's own
// "take applicable observations for total count in case of NA" rule).
app.post('/api/practical/evaluation/save', express.json(), (req, res) => {
  const body = req.body || {};
  const { subCourseID, uniqueID, action } = body;
  if (!subCourseID || !uniqueID || !['Draft', 'Submitted'].includes(action)) {
    return res.status(400).json({ success: false, error: 'subCourseID, uniqueID and a valid action are required' });
  }
  const scores = Array.isArray(body.scores) ? body.scores : [];
  const adminUniqueID = (req.session && req.session.user && req.session.user.uniqueID) || null;

  // Admin-configurable per-course passing % (subcourses.subCoursePassing,
  // editable via courseView.html) - falls back to the historical 70% default
  // only when the column is unset for this course. Looked up fresh on every
  // save so a threshold change made after some scores were already entered
  // takes effect immediately, matching /api/admin/grades/bulkUpdate's rule.
  connection.query(
    'SELECT subCoursePassing FROM subcourses WHERE subCourseID = ? AND courseType = \'practical\' LIMIT 1',
    [subCourseID],
    (passErr, passRows) => {
      if (passErr) {
        console.error('Error loading passing % for practical course:', passErr);
        return res.status(500).json({ success: false, error: 'Database error' });
      }
      if (!passRows.length) {
        return res.status(404).json({ success: false, error: 'Practical course not found' });
      }
      const passThreshold = passRows[0].subCoursePassing == null
        ? PRACTICAL_PASS_PERCENT
        : Number(passRows[0].subCoursePassing);

      const headerQuery = `
    INSERT INTO practicalevaluations
      (subCourseID, uniqueID, employeeCode, dateOfJoining, deptSegmentLine, mcProcess, ojtStartDate, ojtEndDate, evaluationStatus)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      employeeCode = VALUES(employeeCode),
      dateOfJoining = VALUES(dateOfJoining),
      deptSegmentLine = VALUES(deptSegmentLine),
      mcProcess = VALUES(mcProcess),
      ojtStartDate = VALUES(ojtStartDate),
      ojtEndDate = VALUES(ojtEndDate),
      evaluationStatus = VALUES(evaluationStatus)
  `;
  connection.query(
    headerQuery,
    [subCourseID, uniqueID, body.employeeCode || null, body.dateOfJoining || null, body.deptSegmentLine || null,
     body.mcProcess || null, body.ojtStartDate || null, body.ojtEndDate || null, action],
    (headerErr) => {
      if (headerErr) {
        console.error('Error saving practical evaluation header:', headerErr);
        return res.status(500).json({ success: false, error: 'Database error' });
      }

      connection.query(
        `SELECT practicalEvalID FROM practicalevaluations WHERE subCourseID = ? AND uniqueID = ? LIMIT 1`,
        [subCourseID, uniqueID],
        (idErr, idRows) => {
          if (idErr || !idRows.length) {
            console.error('Error resolving practicalEvalID after upsert:', idErr);
            return res.status(500).json({ success: false, error: 'Database error' });
          }
          const practicalEvalID = idRows[0].practicalEvalID;

          const toUpsert = scores.filter(s => s && PRACTICAL_DAY_CODES.includes(s.dayCode) && [0, 1, 2].includes(Number(s.score)));
          const toClear = scores.filter(s => s && PRACTICAL_DAY_CODES.includes(s.dayCode) && (s.score === null || s.score === ''));

          const afterWrites = () => {
            connection.query(
              `SELECT checkpointNo, dayCode, score FROM practicalevaluationscores WHERE practicalEvalID = ?`,
              [practicalEvalID],
              (allErr, allRows) => {
                if (allErr) {
                  console.error('Error reloading practical evaluation scores:', allErr);
                  return res.status(500).json({ success: false, error: 'Database error' });
                }

                const perDay = {};
                PRACTICAL_DAY_CODES.forEach(code => { perDay[code] = { total: 0, count: 0 }; });
                allRows.forEach(r => {
                  if (!perDay[r.dayCode]) return;
                  perDay[r.dayCode].total += Number(r.score);
                  perDay[r.dayCode].count += 1;
                });
                const percentFor = code => (perDay[code].count > 0 ? Number(((perDay[code].total / (perDay[code].count * PRACTICAL_MAX_PER_CHECKPOINT)) * 100).toFixed(2)) : null);
                const dayPercents = {};
                PRACTICAL_DAY_CODES.forEach(code => { dayPercents[code] = percentFor(code); });

                const totalScore = allRows.reduce((sum, r) => sum + Number(r.score), 0);
                const maxScoreApplicable = allRows.length * PRACTICAL_MAX_PER_CHECKPOINT;
                const overallPercent = maxScoreApplicable > 0 ? Number(((totalScore / maxScoreApplicable) * 100).toFixed(2)) : null;

                const day14 = dayPercents.day14, day15 = dayPercents.day15;
                let result = 'Pending';
                if (day14 != null && day15 != null) {
                  result = (day14 >= passThreshold && day15 >= passThreshold) ? 'Pass' : 'Fail';
                }
                const wk3 = dayPercents.wk3, wk4 = dayPercents.wk4;
                let monitoringResult = 'Pending';
                if (wk3 != null && wk4 != null) {
                  monitoringResult = (wk3 >= passThreshold && wk4 >= passThreshold) ? 'Pass' : 'Fail';
                }

                // "Final" pass/fail - the only number Grades Report shows.
                // day10-day13 are observation-only and never mandatory; only
                // day14, day15, wk3, wk4 count. finalPercent is those 4
                // columns' combined score out of 100, and finalResult is
                // Pass only if that combined % AND each of the 4 individual
                // column %s independently clear this course's own passing %
                // (subcourses.subCoursePassing, admin-configurable via
                // courseView.html - defaults to 70 when unset).
                const FINAL_DAY_CODES = ['day14', 'day15', 'wk3', 'wk4'];
                const finalRows = allRows.filter(r => FINAL_DAY_CODES.includes(r.dayCode));
                const finalScore = finalRows.reduce((sum, r) => sum + Number(r.score), 0);
                const finalMaxScore = finalRows.length * PRACTICAL_MAX_PER_CHECKPOINT;
                const finalPercent = finalMaxScore > 0 ? Number(((finalScore / finalMaxScore) * 100).toFixed(2)) : null;
                const finalDayPercents = FINAL_DAY_CODES.map(code => dayPercents[code]);
                let finalResult = 'Pending';
                if (finalDayPercents.every(p => p != null)) {
                  const allFourPass = finalDayPercents.every(p => p >= passThreshold);
                  finalResult = (allFourPass && finalPercent >= passThreshold) ? 'Pass' : 'Fail';
                }

                const updateQuery = `
                  UPDATE practicalevaluations SET
                    day10Percent = ?, day11Percent = ?, day12Percent = ?, day13Percent = ?,
                    day14Percent = ?, day15Percent = ?, wk3Percent = ?, wk4Percent = ?,
                    totalScore = ?, maxScoreApplicable = ?, overallPercent = ?,
                    result = ?, monitoringResult = ?,
                    finalScore = ?, finalMaxScore = ?, finalPercent = ?, finalResult = ?
                    ${action === 'Submitted' ? ', submittedBy = ?, submittedAt = NOW()' : ''}
                  WHERE practicalEvalID = ?
                `;
                const updateParams = [
                  dayPercents.day10, dayPercents.day11, dayPercents.day12, dayPercents.day13,
                  dayPercents.day14, dayPercents.day15, dayPercents.wk3, dayPercents.wk4,
                  totalScore, maxScoreApplicable, overallPercent, result, monitoringResult,
                  finalScore, finalMaxScore, finalPercent, finalResult,
                ];
                if (action === 'Submitted') updateParams.push(adminUniqueID);
                updateParams.push(practicalEvalID);

                connection.query(updateQuery, updateParams, (updateErr) => {
                  if (updateErr) {
                    console.error('Error updating practical evaluation totals:', updateErr);
                    return res.status(500).json({ success: false, error: 'Database error' });
                  }
                  res.json({
                    success: true, practicalEvalID, evaluationStatus: action,
                    dayPercents, totalScore, maxScoreApplicable, overallPercent, result, monitoringResult,
                    finalScore, finalMaxScore, finalPercent, finalResult,
                  });
                });
              }
            );
          };

          const runClear = (cb) => {
            if (!toClear.length) return cb();
            const conditions = toClear.map(() => '(checkpointNo = ? AND dayCode = ?)').join(' OR ');
            const params = [practicalEvalID];
            toClear.forEach(s => params.push(s.checkpointNo, s.dayCode));
            connection.query(
              `DELETE FROM practicalevaluationscores WHERE practicalEvalID = ? AND (${conditions})`,
              params,
              (clearErr) => {
                if (clearErr) console.error('Error clearing practical evaluation scores (non-fatal):', clearErr);
                cb();
              }
            );
          };

          if (!toUpsert.length) {
            return runClear(afterWrites);
          }
          const values = toUpsert.map(s => [practicalEvalID, s.checkpointNo, s.dayCode, Number(s.score)]);
          connection.query(
            `INSERT INTO practicalevaluationscores (practicalEvalID, checkpointNo, dayCode, score) VALUES ?
             ON DUPLICATE KEY UPDATE score = VALUES(score)`,
            [values],
            (upsertErr) => {
              if (upsertErr) {
                console.error('Error upserting practical evaluation scores:', upsertErr);
                return res.status(500).json({ success: false, error: 'Database error' });
              }
              runClear(afterWrites);
            }
          );
        }
      );
    }
  );
    }
  );
});

// ====================================================================
// Level 2 / 3 / 4 Grades Report (admin-only, read-only). Same idea as
// /api/l1/gradesReport - one column per course, one row per user, cell =
// latest score/status - but scoped to a chosen Department/Segment/
// Process-Line (since Level 2+ courses live under that hierarchy) and to a
// single level at a time, picked via the Level 2/3/4 sub-tabs on
// gradesReport.html. Reuses the same level-tagging backward-compat rule as
// registerLevelAcknowledgeRoutes: pre-dropdown courses tagged 'default' (or
// NULL) count as Level 2.
// ====================================================================
function registerLevelGradesReportRoute(levelNum) {
  const levelLabel = `Level ${levelNum}`;
  const levelMatchValues = levelNum === 2 ? [levelLabel, 'default'] : [levelLabel];
  const levelMatchClause = levelNum === 2
    ? '(sc.subCourseLevel IS NULL OR sc.subCourseLevel IN (?))'
    : 'sc.subCourseLevel IN (?)';
  const skillMatrixReportGate = levelNum >= 3
    ? `AND EXISTS (
         SELECT 1 FROM skillmatrix_station_skills sms
         WHERE sms.uniqueID = u.uniqueID
           AND sms.deptID = es.deptID
           AND sms.areaID = es.areaID
           AND sms.mCourseID = es.mCourseID
           AND (sms.stationID = 0 OR es.stationID = 0 OR sms.stationID = es.stationID)
           AND sms.requiredLevel >= ${levelNum}
       )`
    : '';

  app.get(`/api/l${levelNum}/gradesReport`, (req, res) => {
    const { deptID, areaID, mCourseID } = req.query;
    if (!deptID || !areaID || !mCourseID) {
      return res.status(400).json({ success: false, error: 'deptID, areaID and mCourseID are required' });
    }

    const coursesQuery = `
      SELECT subCourseID, subCourseName AS courseName, courseType, subCoursePassing
      FROM subcourses sc
      WHERE (sc.mCourseID = ? OR sc.mCourseID IS NULL)
        AND sc.courseType IN ('assessment', 'training', 'scorm', 'practical')
        AND ${levelMatchClause}
      ORDER BY subCourseID
    `;
    connection.query(coursesQuery, [mCourseID, levelMatchValues], (cErr, courses) => {
      if (cErr) {
        console.error(`Error loading ${levelLabel} courses for grades report:`, cErr);
        return res.status(500).json({ success: false, error: 'Database error' });
      }

      const usersQuery = `
        SELECT DISTINCT u.uniqueID, u.name, u.employeeID, u.uName, u.isPreviousUser, u.previousCourseIDs
        FROM users u
        JOIN enrollstatus es
          ON es.uniqueID = u.uniqueID
          AND es.deptID = ? AND es.areaID = ? AND es.mCourseID = ?
          AND es.coMCourseID IS NULL AND es.subCourseID IS NULL
          AND COALESCE(es.enrollStatus, 'Active') IN ('Active', 'active', 'Enrolled', 'enrolled')
          ${skillMatrixReportGate}
        ORDER BY u.name
      `;
      connection.query(usersQuery, [deptID, areaID, mCourseID], (uErr, users) => {
        if (uErr) {
          console.error(`Error loading enrolled users for ${levelLabel} grades report:`, uErr);
          return res.status(500).json({ success: false, error: 'Database error' });
        }

        if (!courses.length || !users.length) {
          applyPassingModeToCourseList('l2plus', courses)
            .then(finalCourses => res.json({ success: true, courses: finalCourses, users: users.map(u => ({ ...u, grades: {} })) }))
            .catch(err => {
              console.error(`Error applying passing mode to ${levelLabel} course list:`, err);
              res.json({ success: true, courses, users: users.map(u => ({ ...u, grades: {} })) });
            });
          return;
        }

        const userIDs = users.map(u => u.uniqueID);
        const gradesQuery = `
          SELECT
            u.uniqueID,
            la.subCourseID,
            la.courseType,
            CASE
              WHEN la.courseType IN ('assessment', 'scorm') THEN (
                SELECT cg.score FROM coursegrades cg
                WHERE cg.uniqueID = u.uniqueID AND cg.subCourseID = la.subCourseID
                ORDER BY cg.id DESC LIMIT 1
              )
              WHEN la.courseType = 'practical' THEN (
                SELECT pe.finalPercent FROM practicalevaluations pe
                WHERE pe.uniqueID = u.uniqueID AND pe.subCourseID = la.subCourseID AND pe.evaluationStatus = 'Submitted'
                LIMIT 1
              )
              ELSE (
                SELECT tg.score FROM traininggrades tg
                WHERE tg.uniqueID = u.uniqueID AND tg.subCourseID = la.subCourseID
                ORDER BY tg.id DESC LIMIT 1
              )
            END AS latestScore,
            CASE
              WHEN la.courseType IN ('assessment', 'scorm') THEN (
                SELECT cg.status FROM coursegrades cg
                WHERE cg.uniqueID = u.uniqueID AND cg.subCourseID = la.subCourseID
                ORDER BY cg.id DESC LIMIT 1
              )
              WHEN la.courseType = 'practical' THEN (
                SELECT pe.finalResult FROM practicalevaluations pe
                WHERE pe.uniqueID = u.uniqueID AND pe.subCourseID = la.subCourseID AND pe.evaluationStatus = 'Submitted'
                LIMIT 1
              )
              ELSE (
                SELECT tg.status FROM traininggrades tg
                WHERE tg.uniqueID = u.uniqueID AND tg.subCourseID = la.subCourseID
                ORDER BY tg.id DESC LIMIT 1
              )
            END AS latestStatus
          FROM (SELECT uniqueID FROM users WHERE uniqueID IN (?)) u
          JOIN (
            SELECT sc.subCourseID, sc.courseType FROM subcourses sc
            WHERE (sc.mCourseID = ? OR sc.mCourseID IS NULL)
              AND sc.courseType IN ('assessment', 'training', 'scorm', 'practical')
              AND ${levelMatchClause}
          ) la ON 1 = 1
        `;
        connection.query(gradesQuery, [userIDs, mCourseID, levelMatchValues], (gErr, gradeRows) => {
          if (gErr) {
            console.error(`Error loading ${levelLabel} grades for report:`, gErr);
            return res.status(500).json({ success: false, error: 'Database error' });
          }

          // Level 2+ acknowledgement is scoped to this Process/Line (l{n}completedusers
          // has a deptID/areaID/mCourseID on it, unlike the global l1completedusers),
          // so the Certificate button gate only lights up for the line the admin is
          // currently looking at.
          connection.query(
            `SELECT uniqueID, acknowledgeDate FROM l${levelNum}completedusers WHERE mCourseID = ?`,
            [mCourseID],
            (ackErr, ackRows) => {
              if (ackErr) {
                console.error(`Error loading l${levelNum}completedusers for grades report:`, ackErr);
                return res.status(500).json({ success: false, error: 'Database error' });
              }

              const gradeMap = new Map();
              gradeRows.forEach(r => {
                if (!gradeMap.has(r.uniqueID)) gradeMap.set(r.uniqueID, {});
                gradeMap.get(r.uniqueID)[r.subCourseID] = { score: r.latestScore, status: r.latestStatus };
              });

              const ackMap = new Map(ackRows.map(a => [a.uniqueID, a]));

              const result = users.map(u => {
                const ack = ackMap.get(u.uniqueID);
                const grades = gradeMap.get(u.uniqueID) || {};
                const previousIDs = previousCourseIDSet(u.previousCourseIDs);
                if (u.isPreviousUser) {
                  previousIDs.forEach(id => {
                    if (!grades[id]) grades[id] = { score: 100, status: 'Previous User' };
                  });
                }
                return {
                  uniqueID: u.uniqueID,
                  name: u.name,
                  employeeID: u.employeeID,
                  uName: u.uName,
                  grades,
                  applicableCourseIDs: u.isPreviousUser ? Array.from(previousIDs) : undefined,
                  acknowledged: !!ack,
                  acknowledgeDate: ack ? ack.acknowledgeDate : null,
                  isPreviousUser: !!u.isPreviousUser
                };
              });

              applyPassingModeToCourseList('l2plus', courses)
                .then(finalCourses => res.json({ success: true, courses: finalCourses, users: result }))
                .catch(err => {
                  console.error(`Error applying passing mode to ${levelLabel} course list:`, err);
                  res.json({ success: true, courses, users: result });
                });
            }
          );
        });
      });
    });
  });
}

registerLevelGradesReportRoute(2);
registerLevelGradesReportRoute(3);
registerLevelGradesReportRoute(4);

app.get('/api/refresher/gradesReport', async (req, res) => {
  const planMonth = Number(req.query.month) || (new Date().getMonth() + 1);
  const planYear = Number(req.query.year) || new Date().getFullYear();

  if (planMonth < 1 || planMonth > 12 || planYear < 2000) {
    return res.status(400).json({ success: false, error: 'Valid month and year are required' });
  }

  try {
    const db = connection.promise();
    const [courses] = await db.query(
      `SELECT subCourseID, subCourseName AS courseName, courseType, subCoursePassing
       FROM refresher_subcourses
       WHERE courseType IN ('assessment', 'training', 'scorm')
       ORDER BY subCourseID`
    );

    const [users] = await db.query(
      `SELECT DISTINCT
          u.uniqueID, u.name, u.employeeID, u.uName,
          sra.planMonth, sra.planYear
       FROM skillmatrix_refresher_assignments sra
       JOIN users u ON u.uniqueID = sra.uniqueID
       WHERE sra.planMonth = ?
         AND sra.planYear = ?
         AND COALESCE(sra.planCode, 'RT') = 'RT'
         AND sra.status IN ('Planned', 'planned')
       ORDER BY u.name`,
      [planMonth, planYear]
    );

    if (!courses.length || !users.length) {
      const finalCourses = await applyPassingModeToCourseList('refresher', courses);
      return res.json({ success: true, courses: finalCourses, users: users.map(u => ({ ...u, grades: {} })), planMonth, planYear });
    }

    const userIDs = users.map(u => u.uniqueID);
    const [gradeRows] = await db.query(
      `SELECT
          u.uniqueID,
          rc.subCourseID,
          rc.courseType,
          CASE
            WHEN rc.courseType IN ('assessment', 'scorm') THEN (
              SELECT rcg.score
              FROM refresher_coursegrades rcg
              WHERE rcg.uniqueID = u.uniqueID AND rcg.subCourseID = rc.subCourseID
              ORDER BY rcg.id DESC LIMIT 1
            )
            ELSE (
              SELECT rtg.score
              FROM refresher_traininggrades rtg
              WHERE rtg.uniqueID = u.uniqueID AND rtg.subCourseID = rc.subCourseID
              ORDER BY rtg.id DESC LIMIT 1
            )
          END AS latestScore,
          CASE
            WHEN rc.courseType IN ('assessment', 'scorm') THEN (
              SELECT rcg.status
              FROM refresher_coursegrades rcg
              WHERE rcg.uniqueID = u.uniqueID AND rcg.subCourseID = rc.subCourseID
              ORDER BY rcg.id DESC LIMIT 1
            )
            ELSE (
              SELECT rtg.status
              FROM refresher_traininggrades rtg
              WHERE rtg.uniqueID = u.uniqueID AND rtg.subCourseID = rc.subCourseID
              ORDER BY rtg.id DESC LIMIT 1
            )
          END AS latestStatus
       FROM (SELECT uniqueID FROM users WHERE uniqueID IN (?)) u
       JOIN (
          SELECT subCourseID, courseType
          FROM refresher_subcourses
          WHERE courseType IN ('assessment', 'training', 'scorm')
       ) rc ON 1 = 1`,
      [userIDs]
    );

    const gradeMap = new Map();
    gradeRows.forEach(row => {
      if (!gradeMap.has(row.uniqueID)) gradeMap.set(row.uniqueID, {});
      gradeMap.get(row.uniqueID)[row.subCourseID] = { score: row.latestScore, status: row.latestStatus };
    });

    const finalCourses = await applyPassingModeToCourseList('refresher', courses);
    res.json({
      success: true,
      courses: finalCourses,
      users: users.map(u => ({ ...u, grades: gradeMap.get(u.uniqueID) || {} })),
      planMonth,
      planYear
    });
  } catch (error) {
    console.error('Error loading refresher grades report:', error);
    res.status(500).json({ success: false, error: 'Database error', details: error.message });
  }
});


// Route to handle Excel file upload and process MCQs  WORKINGG
// app.post("/uploadExcel", uploadExcelAss.single("mcqFile"), (req, res) => {
//   let { courseID, courseName, courseDescription, courseDate, level, mCourseName } = req.body;
//   const filePath = req.file.path;

//   const uploadPath = 'Excel Assessment/Assessment pages';

//   // Read the uploaded Excel file
//   const workbook = xlsx.readFile(filePath);
//   const sheetName = workbook.SheetNames[0];
//   const worksheet = workbook.Sheets[sheetName];

//   // Parse the worksheet data into JSON
//   const jsonData = xlsx.utils.sheet_to_json(worksheet);

//   // Set courseTags to "default" if it is not provided
//   if (!level || level.trim() === '') {
//     level = 'default';
//   }

//   // Read the HTML template
//   const templatePath = path.join(__dirname, "public", "excelAss_Template.html");
//   let template = fs.readFileSync(templatePath, "utf-8");

//   // // Generate HTML content for MCQs
//   // let htmlContent = `
//   //   <h1>${courseName} (Course ID: ${courseID})</h1>
//   //   <form id="quiz-form">
//   // `;

//   // Insert course data into the courses table
//   const query = `INSERT INTO courses (courseName, courseDescription, courseDate, scormPath, courseID, level, mCourseName) VALUES (?, ?, ?, ?, ?, ?, ?)`;
//   connection.query(query, [courseName, courseDescription, courseDate, uploadPath, courseID, level, mCourseName], (error, results) => {
//     if (error) {
//       console.error('Error saving course data:', error);
//       return res.status(500).send('Internal Server Error');
//     }
//     console.log('Course data saved successfully');

//     // Dynamically create column definitions
//     let columnDefinitions = `
//       id INT AUTO_INCREMENT PRIMARY KEY,
//       uniqueID VARCHAR(255) NOT NULL,
//       employeeID TEXT,
//       name TEXT,
//       noOfAttempts INT DEFAULT 0
//     `;

//     for (let i = 1; i <= 27; i++) {
//       columnDefinitions += `,
//         course_${courseID}_Posttest${i} LONGTEXT,
//         score${i} LONGTEXT,
//         status${i} LONGTEXT,
//         duration${i} LONGTEXT,
//         date${i} TEXT
//       `;
//     }

//     const createTableQuery = `CREATE TABLE IF NOT EXISTS course_${courseID} (${columnDefinitions});`;

//     connection.query(createTableQuery, (err) => {
//       if (err) {
//         console.error('Error creating course table:', err);
//         return res.status(500).send('Error creating course table');
//       }
//       console.log(`Table course_${courseID} created successfully`);

//       // Query the users table to get uniqueID, employeeID, and name
//       const selectUsersQuery = `SELECT uniqueID, employeeID, name FROM users`;

//       connection.query(selectUsersQuery, (err, users) => {
//         if (err) {
//           console.error('Error fetching users data:', err);
//           return res.status(500).send('Error fetching users data');
//         }

//         // Insert data into course_${courseID} table
//         const insertUserData = `INSERT INTO course_${courseID} (uniqueID, employeeID, name) VALUES ?`;
//         const userData = users.map(user => [user.uniqueID, user.employeeID, user.name]);

//         connection.query(insertUserData, [userData], (err) => {
//           if (err) {
//             console.error('Error inserting user data:', err);
//             return res.status(500).send('Error inserting user data');
//           }
//           console.log(`User data inserted into course_${courseID} successfully`);

//           // Generate HTML content for questions
//           let quizQuestions = "";
//           jsonData.forEach((row, index) => {
//             quizQuestions += `
//                <div class="question" data-correct-answer="${row.answerText}">
//                    <p><strong>${index + 1}. ${row.questionText}</strong></p>
//                    <label><input type="radio" name="question${index}" value="${row.option1Text}"> ${row.option1Text}</label><br>
//                    <label><input type="radio" name="question${index}" value="${row.option2Text}"> ${row.option2Text}</label><br>
//                    <label><input type="radio" name="question${index}" value="${row.option3Text}"> ${row.option3Text}</label><br>
//                    <label><input type="radio" name="question${index}" value="${row.option4Text}"> ${row.option4Text}</label><br>
//                </div>
//            `;
//           });
//           // // Generate HTML for each question in jsonData
//           // jsonData.forEach((row, index) => {
//           //   htmlContent += `
//           //   <body>
//           //         <div class="question">
//           //           <p><strong>${index + 1}. ${row.questionText}</strong></p>
//           //           <label><input type="radio" name="question${index}" value="${row.option1Text}"> ${row.option1Text}</label><br>
//           //           <label><input type="radio" name="question${index}" value="${row.option2Text}"> ${row.option2Text}</label><br>
//           //           <label><input type="radio" name="question${index}" value="${row.option3Text}"> ${row.option3Text}</label><br>
//           //           <label><input type="radio" name="question${index}" value="${row.option4Text}"> ${row.option4Text}</label><br>
//           //         </div>
//           //         <script>
//           //             // Send variables to the browser after 5 seconds
//           //             setTimeout(() => {
//           //                 const posttestScore = 0;
//           //                 const status = 'attempted';
//           //                 const score = 0;
//           //                 const duration = 0;

//           //                 // Example: Log to console
//           //                 console.log({ posttestScore, status, score, duration });
//           //                 window.parent.postMessage({ 
//           //                     posttestScore: posttestScore
//           //                 }, "*");

//           //                 // // Example: Store in localStorage
//           //                 // localStorage.setItem('posttestScore', posttestScore);
//           //                 // localStorage.setItem('status', status);
//           //                 // localStorage.setItem('score', score);
//           //                 // localStorage.setItem('duration', duration);
//           //             }, 5000); // 5000ms = 5 seconds
//           //         </script>
//           //     </body>
//           //   `;
//           // });

//           // htmlContent += `<button type="submit">Submit</button></form>`;

//           // Replace placeholders in the template
//           const finalQuizHTML = template
//             .replace(/{{courseName}}/g, courseName)
//             .replace(/{{courseID}}/g, courseID)
//             .replace(/{{quizQuestions}}/g, quizQuestions);

//           // Save HTML file
//           const htmlFilePath = path.join(__dirname, "uploads", "Excel Assessment", "Assessment pages", `${courseID}_quiz.html`);
//           fs.writeFileSync(htmlFilePath, finalQuizHTML);

//           // Send final response with HTML and JavaScript combined
//           res.send(`
//             <p>File uploaded and quiz generated successfully!</p>
//             <a href="/">Upload another file</a> | 
//             <a href="/quiz/${courseID}">View Quiz</a>
//             <script>
//               const uploadConfirmation = confirm('Course uploaded successfully.');
//               if (uploadConfirmation) {
//                   // <p>File uploaded and quiz generated successfully!</p>
//                   // <a href="/createCourse">Upload another file</a> | 
//                   // <a href="/quiz/${courseID}">View Quiz</a>
//                   window.location.href = '/createCourse.html';
//               }
//             </script>
//           `);
//         });
//       });
//     });
//   });
// });





// Route to serve the generated HTML quiz page
app.get("/quiz/:courseID", (req, res) => {
  const htmlFilePath = path.join(__dirname, "uploads", "Excel Assessment", "Assessment pages", `${req.params.courseID}_quiz.html`);
  if (fs.existsSync(htmlFilePath)) {
    res.sendFile(htmlFilePath);
  } else {
    res.status(404).send("Quiz not found.");
  }
});







// Route to handle Excel file upload and process MCQs
// app.post("/uploadTraining", uploadFiles, (req, res) => {

//   console.log("Files received:", req.files);
//   console.log("Body received:", req.body);

//   let { courseID, courseName, courseDescription, courseDate, courseTags } = req.body;

//   const mcqFile = req.files.mcqFile?.[0];
//   const videoFile = req.files["videoFile"]?.[0];

//   if (!mcqFile) {
//     return res.status(400).send("MCQ file is missing!");
//   }
//   const mcqFilePath = path.join(__dirname, "uploads", "Training Assessment", "Posttest assessment", `${Date.now()}_${mcqFile.originalname}`);
//   const videoFilePath = videoFile
//     // ? path.join(__dirname, "uploads", "Training Assessment", "Videos", `${Date.now()}_${videoFile.originalname}`)
//     ? path.join(__dirname, "uploads", "Training Assessment", "Videos", `${courseID}_video.mp4`)
//     : null;

//   try {
//     fs.writeFileSync(mcqFilePath, mcqFile.buffer);
//     console.log(`MCQ file saved at: ${mcqFilePath}`);

//     if (!fs.existsSync(mcqFilePath)) {
//       throw new Error("MCQ file path is invalid!");
//     }
//     //const videoFile = req.files.videoFile[0];

//     //const filePath = mcqFile.path;

//     const uploadPath = 'uploads/Training Assessment/Posttest assessment/training pages';

//     // Read the uploaded Excel file
//     const workbook = xlsx.readFile(mcqFilePath);
//     const sheetName = workbook.SheetNames[0];
//     const worksheet = workbook.Sheets[sheetName];

//     // Handle video file

//     if (videoFile) {
//       fs.writeFileSync(videoFilePath, videoFile.buffer);
//       console.log(`Video file saved at: ${videoFilePath}`);
//       const videoPath = path.join("uploads", "Training Assessment", "Videos");
//       console.log(`Video saved at: ${videoPath}`);
//     }
//     // Parse the worksheet data into JSON
//     const jsonData = xlsx.utils.sheet_to_json(worksheet);

//     // Set courseTags to "default" if it is not provided
//     if (!courseTags || courseTags.trim() === '') {
//       courseTags = 'default';
//     }

//     // Read the HTML template
//     const templatePath = path.join(__dirname, "public", "trainingAss_Template.html");
//     let template = fs.readFileSync(templatePath, "utf-8");
//     const query = `INSERT INTO courses (courseName, courseDescription, courseDate, scormPath, courseID, courseTags) VALUES (?, ?, ?, ?, ?, ?)`;
//     connection.query(query, [courseName, courseDescription, courseDate, uploadPath, courseID, courseTags], (error, results) => {
//       if (error) {
//         console.error('Error saving course data:', error);
//         return res.status(500).send('Internal Server Error');
//       }
//       console.log('Course data saved successfully');

//       // Dynamically create column definitions
//       let columnDefinitions = `
//       id INT AUTO_INCREMENT PRIMARY KEY,
//       uniqueID VARCHAR(255) NOT NULL,
//       employeeID TEXT,
//       name TEXT,
//       noOfAttempts INT DEFAULT 0
//     `;

//       for (let i = 1; i <= 27; i++) {
//         columnDefinitions += `,
//         course_${courseID}_Posttest${i} LONGTEXT,
//         score${i} LONGTEXT,
//         status${i} LONGTEXT,
//         duration${i} LONGTEXT,
//         date${i} TEXT
//       `;
//       }

//       const createTableQuery = `CREATE TABLE IF NOT EXISTS course_${courseID} (${columnDefinitions});`;

//       connection.query(createTableQuery, (err) => {
//         if (err) {
//           console.error('Error creating course table:', err);
//           return res.status(500).send('Error creating course table');
//         }
//         console.log(`Table course_${courseID} created successfully`);

//         // Query the users table to get uniqueID, employeeID, and name
//         const selectUsersQuery = `SELECT uniqueID, employeeID, name FROM users`;

//         connection.query(selectUsersQuery, (err, users) => {
//           if (err) {
//             console.error('Error fetching users data:', err);
//             return res.status(500).send('Error fetching users data');
//           }

//           // Insert data into course_${courseID} table
//           const insertUserData = `INSERT INTO course_${courseID} (uniqueID, employeeID, name) VALUES ?`;
//           const userData = users.map(user => [user.uniqueID, user.employeeID, user.name]);

//           connection.query(insertUserData, [userData], (err) => {
//             if (err) {
//               console.error('Error inserting user data:', err);
//               return res.status(500).send('Error inserting user data');
//             }
//             console.log(`User data inserted into course_${courseID} successfully`);

//             // Generate HTML content for questions
//             let quizQuestions = "";
//             jsonData.forEach((row, index) => {
//               quizQuestions += `
//                <div class="question" data-correct-answer="${row.answerText}">
//                    <p><strong>${index + 1}. ${row.questionText}</strong></p>
//                    <label><input type="radio" name="question${index}" value="${row.option1Text}"> ${row.option1Text}</label><br>
//                    <label><input type="radio" name="question${index}" value="${row.option2Text}"> ${row.option2Text}</label><br>
//                    <label><input type="radio" name="question${index}" value="${row.option3Text}"> ${row.option3Text}</label><br>
//                    <label><input type="radio" name="question${index}" value="${row.option4Text}"> ${row.option4Text}</label><br>
//                </div>
//            `;
//             });

//             // Replace placeholders in the template
//             const finalQuizHTML = template
//               .replace(/{{courseName}}/g, courseName)
//               .replace(/{{courseID}}/g, courseID)
//               .replace(/{{quizQuestions}}/g, quizQuestions);

//             // Save HTML file
//             const htmlFilePath = path.join(__dirname, "uploads", "Training Assessment", "Posttest assessment", "training pages", `${courseID}_quiz.html`);
//             fs.writeFileSync(htmlFilePath, finalQuizHTML);

//             // Send final response with HTML and JavaScript combined
//             res.send(`
//             <p>File uploaded and quiz generated successfully!</p>
//             <a href="/">Upload another file</a> | 
//             <a href="/training/${courseID}">View Quiz</a>
//             <script>
//               const uploadConfirmation = confirm('Course uploaded successfully.');
//               if (uploadConfirmation) {
//                   // <p>File uploaded and quiz generated successfully!</p>
//                   // <a href="/createCourse">Upload another file</a> | 
//                   // <a href="/training/${courseID}">View Quiz</a>
//                   window.location.href = '/createCourse.html';
//               }
//             </script>
//           `);
//           });
//         });
//       });
//     });
//   }
//   catch (err) {
//     console.error("Error processing files:", err);
//     res.status(500).send("Error processing uploaded files.");
//   }


// });
app.get('/getmCourseName', (req, res) => {
  const normalizedQuery = `
    SELECT
      m.mCourseID AS id,
      m.mCourseName AS name,
      m.deptID,
      m.areaID,
      d.deptName,
      a.areaName
    FROM mcourses m
    LEFT JOIN departments d ON d.deptID = m.deptID
    LEFT JOIN areas a ON a.areaID = m.areaID
    ORDER BY m.mCourseName
  `;

  connection.query(normalizedQuery, (normalizedError, normalizedResults) => {
    if (!normalizedError) {
      return res.json({ mCourseName: normalizedResults });
    }

    if (!shouldFallbackToLegacySchema(normalizedError)) {
      console.error('Error fetching normalized process/line list:', normalizedError);
      return res.status(500).json({ error: 'Internal server error' });
    }

    const query = 'SELECT id, mCourseName FROM department';

    connection.query(query, (error, results) => {
      if (error) {
        console.error('Error fetching mCourseName:', error);
        res.status(500).json({ error: 'Internal server error' });
        return;
      }

      const mCourseName = results.map(row => ({
        id: row.id,
        name: row.mCourseName
      }));

      res.json({ mCourseName });
    });
  });
});

app.get('/api/hierarchy/departments', (req, res) => {
  const query = 'SELECT deptID, deptName, deptDescription, deptDate FROM departments ORDER BY deptName';
  connection.query(query, (error, results) => {
    if (error) {
      console.error('Error fetching departments:', error);
      return res.status(500).json({ success: false, error: 'Database error', details: error.message });
    }
    res.json({ success: true, departments: results });
  });
});

app.post('/api/hierarchy/departments', express.json(), (req, res) => {
  const { deptName, deptDescription, deptDate } = req.body;
  if (!String(deptName || '').trim()) {
    return res.status(400).json({ success: false, error: 'Department name is required' });
  }

  const query = `
    INSERT INTO departments (deptName, deptDescription, deptDate)
    VALUES (?, ?, ?)
  `;
  connection.query(query, [deptName.trim(), deptDescription || '', deptDate || null], (error, result) => {
    if (error) {
      console.error('Error creating department:', error);
      return res.status(500).json({ success: false, error: 'Database error', details: error.message });
    }
    res.status(201).json({ success: true, deptID: result.insertId });
  });
});

app.put('/api/hierarchy/departments/:deptID', express.json(), (req, res) => {
  const { deptID } = req.params;
  const { deptName, deptDescription, deptDate } = req.body;
  if (!String(deptName || '').trim()) {
    return res.status(400).json({ success: false, error: 'Department name is required' });
  }

  const query = 'UPDATE departments SET deptName = ?, deptDescription = ?, deptDate = ? WHERE deptID = ?';
  connection.query(query, [deptName.trim(), deptDescription || '', deptDate || null, deptID], (error, result) => {
    if (error) {
      console.error('Error updating department:', error);
      return res.status(500).json({ success: false, error: 'Database error', details: error.message });
    }
    if (!result.affectedRows) {
      return res.status(404).json({ success: false, error: 'Department not found' });
    }
    res.json({ success: true });
  });
});

app.delete('/api/hierarchy/departments/:deptID', (req, res) => {
  const { deptID } = req.params;

  connection.query('SELECT COUNT(*) AS total FROM areas WHERE deptID = ?', [deptID], (countError, countRows) => {
    if (countError) {
      console.error('Error checking department dependencies:', countError);
      return res.status(500).json({ success: false, error: 'Database error', details: countError.message });
    }

    if (countRows[0].total > 0) {
      return res.status(409).json({ success: false, error: 'Delete segments/areas under this department first' });
    }

    connection.query('DELETE FROM departments WHERE deptID = ?', [deptID], (error, result) => {
      if (error) {
        console.error('Error deleting department:', error);
        return res.status(500).json({ success: false, error: 'Database error', details: error.message });
      }

      res.json({ success: true, deleted: result.affectedRows });
    });
  });
});

app.get('/api/hierarchy/areas', (req, res) => {
  const { deptID } = req.query;
  const params = [];
  let query = `
    SELECT areaID, deptID, areaName, areaDescription, areaDate
    FROM areas
  `;

  if (deptID) {
    query += ' WHERE deptID = ?';
    params.push(deptID);
  }

  query += ' ORDER BY areaName';

  connection.query(query, params, (error, results) => {
    if (error) {
      console.error('Error fetching areas:', error);
      return res.status(500).json({ success: false, error: 'Database error', details: error.message });
    }
    res.json({ success: true, areas: results });
  });
});

app.post('/api/hierarchy/areas', express.json(), (req, res) => {
  const { deptID, areaName, areaDescription, areaDate } = req.body;
  if (!deptID || !String(areaName || '').trim()) {
    return res.status(400).json({ success: false, error: 'Department and segment/area name are required' });
  }

  const query = `
    INSERT INTO areas (deptID, areaName, areaDescription, areaDate)
    VALUES (?, ?, ?, ?)
  `;
  connection.query(query, [deptID, areaName.trim(), areaDescription || '', areaDate || null], (error, result) => {
    if (error) {
      console.error('Error creating area:', error);
      return res.status(500).json({ success: false, error: 'Database error', details: error.message });
    }
    res.status(201).json({ success: true, areaID: result.insertId });
  });
});

app.put('/api/hierarchy/areas/:areaID', express.json(), (req, res) => {
  const { areaID } = req.params;
  const { areaName, areaDescription, areaDate } = req.body;
  if (!String(areaName || '').trim()) {
    return res.status(400).json({ success: false, error: 'Segment/area name is required' });
  }

  const query = 'UPDATE areas SET areaName = ?, areaDescription = ?, areaDate = ? WHERE areaID = ?';
  connection.query(query, [areaName.trim(), areaDescription || '', areaDate || null, areaID], (error, result) => {
    if (error) {
      console.error('Error updating area:', error);
      return res.status(500).json({ success: false, error: 'Database error', details: error.message });
    }
    if (!result.affectedRows) {
      return res.status(404).json({ success: false, error: 'Segment/area not found' });
    }
    res.json({ success: true });
  });
});

app.delete('/api/hierarchy/areas/:areaID', (req, res) => {
  const { areaID } = req.params;

  connection.query('SELECT COUNT(*) AS total FROM mcourses WHERE areaID = ?', [areaID], (countError, countRows) => {
    if (countError) {
      console.error('Error checking area dependencies:', countError);
      return res.status(500).json({ success: false, error: 'Database error', details: countError.message });
    }

    if (countRows[0].total > 0) {
      return res.status(409).json({ success: false, error: 'Delete processes/lines under this segment first' });
    }

    connection.query('DELETE FROM areas WHERE areaID = ?', [areaID], (error, result) => {
      if (error) {
        console.error('Error deleting area:', error);
        return res.status(500).json({ success: false, error: 'Database error', details: error.message });
      }

      res.json({ success: true, deleted: result.affectedRows });
    });
  });
});

function createDefaultComainCourseForLine(line, callback) {
  const query = `
    INSERT INTO comaincourses
      (deptID, areaID, mCourseID, coMCourseName, coMCourseDescription, coMCourseDate, coMCourseRemark, isDefaultForLine)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, 1)
  `;
  const dateText = line.mCourseDate || new Date().toISOString().slice(0, 10);
  const name = `${line.mCourseName} Default`;
  connection.query(
    query,
    [line.deptID, line.areaID, line.mCourseID, name, 'Default hidden group for Mahindra line/process', dateText, 'Hidden default group'],
    callback
  );
}

app.get('/api/hierarchy/processes', (req, res) => {
  const { deptID, areaID, mCourseID } = req.query;
  const params = [];
  let query = `
    SELECT mCourseID, deptID, areaID, mCourseName, mCourseDescription, mCourseDate, mCourseLevel, mCourseRemark
    FROM mcourses
    WHERE 1 = 1
  `;

  if (deptID) {
    query += ' AND deptID = ?';
    params.push(deptID);
  }
  if (areaID) {
    query += ' AND areaID = ?';
    params.push(areaID);
  }
  // Optional direct lookup by mCourseID - used by public/l2Courses.html to
  // resolve a Process/Line's Department + Segment/Area when it arrives via a
  // post-upload redirect that only carries mCourseID. Existing callers never
  // pass this param, so their behavior is unaffected.
  if (mCourseID) {
    query += ' AND mCourseID = ?';
    params.push(mCourseID);
  }

  query += ' ORDER BY mCourseName';

  connection.query(query, params, (error, results) => {
    if (error) {
      console.error('Error fetching processes/lines:', error);
      return res.status(500).json({ success: false, error: 'Database error', details: error.message });
    }
    res.json({ success: true, processes: results });
  });
});

app.post('/api/hierarchy/processes', express.json(), (req, res) => {
  const { deptID, areaID, mCourseName, mCourseDescription, mCourseDate, mCourseLevel, mCourseRemark } = req.body;
  if (!deptID || !areaID || !String(mCourseName || '').trim() || !String(mCourseLevel || '').trim()) {
    return res.status(400).json({ success: false, error: 'Department, segment/area, process/line name, and required level are required' });
  }

  const query = `
    INSERT INTO mcourses
      (deptID, areaID, mCourseName, mCourseDescription, mCourseDate, mCourseLevel, mCourseRemark)
    VALUES
      (?, ?, ?, ?, ?, ?, ?)
  `;

  connection.query(
    query,
    [deptID, areaID, mCourseName.trim(), mCourseDescription || '', mCourseDate || null, mCourseLevel.trim(), mCourseRemark || ''],
    (error, result) => {
      if (error) {
        console.error('Error creating process/line:', error);
        return res.status(500).json({ success: false, error: 'Database error', details: error.message });
      }

      const line = {
        deptID,
        areaID,
        mCourseID: result.insertId,
        mCourseName: mCourseName.trim(),
        mCourseDate: mCourseDate || null,
      };

      createDefaultComainCourseForLine(line, (defaultError, defaultResult) => {
        if (defaultError) {
          console.error('Error creating default hidden course group:', defaultError);
          return res.status(500).json({
            success: false,
            error: 'Process/line created but hidden default group failed',
            mCourseID: result.insertId,
            details: defaultError.message
          });
        }

        res.status(201).json({
          success: true,
          mCourseID: result.insertId,
          coMCourseID: defaultResult.insertId
        });
      });
    }
  );
});

app.put('/api/hierarchy/processes/:mCourseID', express.json(), (req, res) => {
  const { mCourseID } = req.params;
  const { mCourseName, mCourseDescription, mCourseDate, mCourseLevel, mCourseRemark } = req.body;
  if (!String(mCourseName || '').trim() || !String(mCourseLevel || '').trim()) {
    return res.status(400).json({ success: false, error: 'Process/line name and required level are required' });
  }

  const query = `
    UPDATE mcourses SET
      mCourseName = ?, mCourseDescription = ?, mCourseDate = ?, mCourseLevel = ?, mCourseRemark = ?
    WHERE mCourseID = ?
  `;
  connection.query(
    query,
    [mCourseName.trim(), mCourseDescription || '', mCourseDate || null, mCourseLevel.trim(), mCourseRemark || '', mCourseID],
    (error, result) => {
      if (error) {
        console.error('Error updating process/line:', error);
        return res.status(500).json({ success: false, error: 'Database error', details: error.message });
      }
      if (!result.affectedRows) {
        return res.status(404).json({ success: false, error: 'Process/line not found' });
      }
      res.json({ success: true });
    }
  );
});

app.delete('/api/hierarchy/processes/:mCourseID', (req, res) => {
  const { mCourseID } = req.params;

  connection.query('SELECT COUNT(*) AS total FROM subcourses WHERE mCourseID = ?', [mCourseID], (countError, countRows) => {
    if (countError) {
      console.error('Error checking process dependencies:', countError);
      return res.status(500).json({ success: false, error: 'Database error', details: countError.message });
    }

    if (countRows[0].total > 0) {
      return res.status(409).json({ success: false, error: 'Delete courses under this process/line first' });
    }

    connection.query('DELETE FROM comaincourses WHERE mCourseID = ?', [mCourseID], (groupError) => {
      if (groupError) {
        console.error('Error deleting hidden course group:', groupError);
        return res.status(500).json({ success: false, error: 'Database error', details: groupError.message });
      }

      connection.query('DELETE FROM mcourses WHERE mCourseID = ?', [mCourseID], (error, result) => {
        if (error) {
          console.error('Error deleting process/line:', error);
          return res.status(500).json({ success: false, error: 'Database error', details: error.message });
        }

        res.json({ success: true, deleted: result.affectedRows });
      });
    });
  });
});

// --------------------------------------------------------------------------
// STATIONS (Machine) - one level under Process/Line. Mirrors the
// Department/Area/Process CRUD pattern exactly.
// --------------------------------------------------------------------------

app.get('/api/hierarchy/stations', (req, res) => {
  const { mCourseID } = req.query;
  const params = [];
  let query = `
    SELECT stationID, deptID, areaID, mCourseID, stationName, stationDescription, stationDate, requiredManpower
    FROM stations
    WHERE 1 = 1
  `;

  if (mCourseID) {
    query += ' AND mCourseID = ?';
    params.push(mCourseID);
  }

  query += ' ORDER BY stationName';

  connection.query(query, params, (error, results) => {
    if (error) {
      console.error('Error fetching stations:', error);
      return res.status(500).json({ success: false, error: 'Database error', details: error.message });
    }
    res.json({ success: true, stations: results });
  });
});

app.post('/api/hierarchy/stations', express.json(), (req, res) => {
  const { deptID, areaID, mCourseID, stationName, stationDescription, stationDate, requiredManpower } = req.body;
  if (!mCourseID || !String(stationName || '').trim()) {
    return res.status(400).json({ success: false, error: 'Process/Line and station name are required' });
  }
  const manpowerValue = (requiredManpower === '' || requiredManpower === undefined || requiredManpower === null)
    ? null
    : Number(requiredManpower);

  const query = `
    INSERT INTO stations (deptID, areaID, mCourseID, stationName, stationDescription, stationDate, requiredManpower)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `;
  connection.query(
    query,
    [deptID || null, areaID || null, mCourseID, stationName.trim(), stationDescription || '', stationDate || null, manpowerValue],
    (error, result) => {
      if (error) {
        console.error('Error creating station:', error);
        return res.status(500).json({ success: false, error: 'Database error', details: error.message });
      }
      res.status(201).json({ success: true, stationID: result.insertId });
    }
  );
});

app.put('/api/hierarchy/stations/:stationID', express.json(), (req, res) => {
  const { stationID } = req.params;
  const { stationName, stationDescription, stationDate, requiredManpower } = req.body;
  if (!String(stationName || '').trim()) {
    return res.status(400).json({ success: false, error: 'Station name is required' });
  }
  const manpowerValue = (requiredManpower === '' || requiredManpower === undefined || requiredManpower === null)
    ? null
    : Number(requiredManpower);

  const query = 'UPDATE stations SET stationName = ?, stationDescription = ?, stationDate = ?, requiredManpower = ? WHERE stationID = ?';
  connection.query(query, [stationName.trim(), stationDescription || '', stationDate || null, manpowerValue, stationID], (error, result) => {
    if (error) {
      console.error('Error updating station:', error);
      return res.status(500).json({ success: false, error: 'Database error', details: error.message });
    }
    if (!result.affectedRows) {
      return res.status(404).json({ success: false, error: 'Station not found' });
    }
    res.json({ success: true });
  });
});

app.delete('/api/hierarchy/stations/:stationID', (req, res) => {
  const { stationID } = req.params;

  connection.query('SELECT COUNT(*) AS total FROM subcourses WHERE stationID = ?', [stationID], (countError, countRows) => {
    if (countError) {
      console.error('Error checking station dependencies:', countError);
      return res.status(500).json({ success: false, error: 'Database error', details: countError.message });
    }

    if (countRows[0].total > 0) {
      return res.status(409).json({ success: false, error: 'Delete courses under this station first' });
    }

    connection.query('DELETE FROM stations WHERE stationID = ?', [stationID], (error, result) => {
      if (error) {
        console.error('Error deleting station:', error);
        return res.status(500).json({ success: false, error: 'Database error', details: error.message });
      }
      res.json({ success: true, deleted: result.affectedRows });
    });
  });
});

// --------------------------------------------------------------------------
// PROCESS-LEVEL ENROLLMENT (Harman-style hierarchy assignment)
// Assign a user/users to a Department -> Segment/Area -> Process/Line node.
// This is broader than the existing per-course /enrollUsersToCourse route:
// it inserts an enrollstatus row with coMCourseID/subCourseID left NULL, which
// /getViewscormCourseList already treats as "matches every subCourse under
// this mCourseID" (see the `(es.coMCourseID IS NULL OR ...)` style conditions
// in that query). So one enrollstatus row here unlocks every Level 2+ course
// under the chosen process/line for that user.
// --------------------------------------------------------------------------

app.post('/api/enrollstatus/assignProcess', express.json(), (req, res) => {
  const { deptID, areaID, mCourseID, users } = req.body || {};
  const selectedUsers = Array.isArray(users) ? users : [];

  if (!deptID || !areaID || !mCourseID) {
    return res.status(400).json({ success: false, error: 'deptID, areaID and mCourseID are required' });
  }
  if (!selectedUsers.length) {
    return res.status(400).json({ success: false, error: 'No users selected for enrollment' });
  }

  const userUniqueIDs = selectedUsers.map(u => u.uniqueID).filter(Boolean);
  if (!userUniqueIDs.length) {
    return res.status(400).json({ success: false, error: 'No valid uniqueID values supplied' });
  }

  const checkQuery = `
    SELECT uniqueID
    FROM enrollstatus
    WHERE deptID = ?
      AND areaID = ?
      AND mCourseID = ?
      AND coMCourseID IS NULL
      AND subCourseID IS NULL
      AND uniqueID IN (?)
      AND COALESCE(enrollStatus, 'Active') IN ('Active', 'active', 'Enrolled', 'enrolled')
  `;

  connection.query(checkQuery, [deptID, areaID, mCourseID, userUniqueIDs], (checkError, existingRows) => {
    if (checkError) {
      console.error('Error checking existing process enrollment:', checkError);
      return res.status(500).json({ success: false, error: 'Database error', details: checkError.message });
    }

    const alreadyEnrolled = new Set(existingRows.map(row => String(row.uniqueID)));
    const newUniqueIDs = userUniqueIDs.filter(id => !alreadyEnrolled.has(String(id)));

    if (!newUniqueIDs.length) {
      return res.json({ success: true, inserted: 0, skipped: userUniqueIDs.length, message: 'All selected users are already enrolled in this process/line.' });
    }

    const enrollDateText = new Date().toLocaleDateString('en-GB', {});
    const todayISO = new Date().toISOString().slice(0, 10);

    const values = newUniqueIDs.map(uniqueID => [
      uniqueID, deptID, areaID, mCourseID, null, null,
      enrollDateText, todayISO, null, 'Active', null, null
    ]);

    const insertQuery = `
      INSERT INTO enrollstatus
        (uniqueID, deptID, areaID, mCourseID, coMCourseID, subCourseID, enrollDate, startDate, endDate, enrollStatus, multiSkill, activeTrainingStations)
      VALUES ?
    `;

    connection.query(insertQuery, [values], (insertError, insertResult) => {
      if (insertError) {
        console.error('Error inserting process enrollment:', insertError);
        return res.status(500).json({ success: false, error: 'Database error', details: insertError.message });
      }

      const adminUniqueID = (req.session && req.session.user && req.session.user.uniqueID) || null;
      const firstInsertID = insertResult.insertId;
      const logRows = newUniqueIDs.map((uniqueID, idx) => [
        firstInsertID + idx, uniqueID, deptID, areaID, mCourseID, null, null,
        'ENROLL_PROCESS', adminUniqueID, 'Process/line enrollment via Enrollment page'
      ]);
      const logQuery = `
        INSERT INTO enrolllogs
          (enrollID, uniqueID, deptID, areaID, mCourseID, coMCourseID, subCourseID, action, actionBy, remark)
        VALUES ?
      `;
      connection.query(logQuery, [logRows], (logError) => {
        if (logError) {
          console.error('Error writing enrolllogs (non-fatal):', logError);
        }
        res.json({
          success: true,
          inserted: newUniqueIDs.length,
          skipped: alreadyEnrolled.size,
          message: alreadyEnrolled.size > 0 ? 'Some users were already enrolled and were skipped.' : 'Users enrolled successfully.'
        });
      });
    });
  });
});

app.get('/api/enrollstatus/listByProcess', (req, res) => {
  const { deptID, areaID, mCourseID } = req.query;
  if (!deptID || !areaID || !mCourseID) {
    return res.status(400).json({ success: false, error: 'deptID, areaID and mCourseID are required' });
  }

  const query = `
    SELECT u.uniqueID, u.name, u.employeeID, u.uName, es.enrollDate, es.startDate,
           es.stationID, st.stationName
    FROM enrollstatus es
    JOIN users u ON u.uniqueID = es.uniqueID
    LEFT JOIN stations st ON st.stationID = es.stationID AND es.stationID <> 0
    WHERE es.deptID = ?
      AND es.areaID = ?
      AND es.mCourseID = ?
      AND es.coMCourseID IS NULL
      AND es.subCourseID IS NULL
      AND COALESCE(es.enrollStatus, 'Active') IN ('Active', 'active', 'Enrolled', 'enrolled')
    ORDER BY u.name
  `;

  connection.query(query, [deptID, areaID, mCourseID], (error, results) => {
    if (error) {
      console.error('Error listing process enrollment:', error);
      return res.status(500).json({ success: false, error: 'Database error', details: error.message });
    }
    res.json({ success: true, users: results });
  });
});

// --------------------------------------------------------------------------
// STATION ASSIGNMENT (Stage 1 of multi-PC / segment deployment)
// A user already enrolled in a Process/Line (see assignProcess above) can be
// pinned to one specific Station on that line. stationID=0 remains the
// "whole line, no specific station" sentinel. This assignment is what gets
// carried via the Level 1 certificate barcode to the correct Segment PC.
// --------------------------------------------------------------------------

app.post('/api/enrollstatus/assignStation', express.json(), (req, res) => {
  const { deptID, areaID, mCourseID, stationID, uniqueID } = req.body || {};
  if (!deptID || !areaID || !mCourseID || !uniqueID) {
    return res.status(400).json({ success: false, error: 'deptID, areaID, mCourseID and uniqueID are required' });
  }
  const resolvedStationID = stationID ? Number(stationID) : 0;

  const findQuery = `
    SELECT enrollID
    FROM enrollstatus
    WHERE deptID = ? AND areaID = ? AND mCourseID = ? AND coMCourseID IS NULL AND subCourseID IS NULL
      AND uniqueID = ?
      AND COALESCE(enrollStatus, 'Active') IN ('Active', 'active', 'Enrolled', 'enrolled')
    ORDER BY enrollID DESC
    LIMIT 1
  `;

  connection.query(findQuery, [deptID, areaID, mCourseID, uniqueID], (findError, rows) => {
    if (findError) {
      console.error('Error finding enrollment for station assignment:', findError);
      return res.status(500).json({ success: false, error: 'Database error', details: findError.message });
    }
    if (!rows.length) {
      return res.status(404).json({ success: false, error: 'User is not enrolled in this process/line yet. Enroll them first.' });
    }

    const applyUpdate = () => {
      connection.query(
        'UPDATE enrollstatus SET stationID = ? WHERE enrollID = ?',
        [resolvedStationID, rows[0].enrollID],
        (updateError) => {
          if (updateError) {
            console.error('Error assigning station:', updateError);
            return res.status(500).json({ success: false, error: 'Database error', details: updateError.message });
          }

          const adminUniqueID = (req.session && req.session.user && req.session.user.uniqueID) || null;
          connection.query(
            `INSERT INTO enrolllogs (enrollID, uniqueID, deptID, areaID, mCourseID, coMCourseID, subCourseID, action, actionBy, remark)
             VALUES (?, ?, ?, ?, ?, NULL, NULL, 'ASSIGN_STATION', ?, ?)`,
            [rows[0].enrollID, uniqueID, deptID, areaID, mCourseID, adminUniqueID, resolvedStationID ? `Assigned stationID ${resolvedStationID}` : 'Cleared station assignment (whole line)'],
            (logError) => {
              if (logError) console.error('Error writing enrolllogs (non-fatal):', logError);
              res.json({ success: true, stationID: resolvedStationID });
            }
          );
        }
      );
    };

    if (!resolvedStationID) {
      applyUpdate();
      return;
    }

    // Validate the station actually belongs to this process/line before assigning.
    connection.query('SELECT stationID FROM stations WHERE stationID = ? AND mCourseID = ?', [resolvedStationID, mCourseID], (stError, stRows) => {
      if (stError) {
        console.error('Error validating station:', stError);
        return res.status(500).json({ success: false, error: 'Database error', details: stError.message });
      }
      if (!stRows.length) {
        return res.status(400).json({ success: false, error: 'Selected station does not belong to this process/line' });
      }
      applyUpdate();
    });
  });
});

app.post('/api/enrollstatus/removeProcessAssignment', express.json(), (req, res) => {
  const { deptID, areaID, mCourseID, uniqueID } = req.body || {};
  if (!deptID || !areaID || !mCourseID || !uniqueID) {
    return res.status(400).json({ success: false, error: 'deptID, areaID, mCourseID and uniqueID are required' });
  }

  const findQuery = `
    SELECT enrollID
    FROM enrollstatus
    WHERE deptID = ? AND areaID = ? AND mCourseID = ? AND coMCourseID IS NULL AND subCourseID IS NULL
      AND uniqueID = ?
      AND COALESCE(enrollStatus, 'Active') IN ('Active', 'active', 'Enrolled', 'enrolled')
    ORDER BY enrollID DESC
    LIMIT 1
  `;

  connection.query(findQuery, [deptID, areaID, mCourseID, uniqueID], (findError, rows) => {
    if (findError) {
      console.error('Error finding process enrollment to remove:', findError);
      return res.status(500).json({ success: false, error: 'Database error', details: findError.message });
    }
    if (!rows.length) {
      return res.status(404).json({ success: false, error: 'No active enrollment found for this user/process' });
    }

    const enrollID = rows[0].enrollID;
    connection.query(
      `UPDATE enrollstatus SET enrollStatus = 'Inactive', endDate = CURDATE() WHERE enrollID = ?`,
      [enrollID],
      (updateError) => {
        if (updateError) {
          console.error('Error removing process enrollment:', updateError);
          return res.status(500).json({ success: false, error: 'Database error', details: updateError.message });
        }

        const adminUniqueID = (req.session && req.session.user && req.session.user.uniqueID) || null;
        connection.query(
          `INSERT INTO enrolllogs (enrollID, uniqueID, deptID, areaID, mCourseID, coMCourseID, subCourseID, action, actionBy, remark)
           VALUES (?, ?, ?, ?, ?, NULL, NULL, 'UNENROLL_PROCESS', ?, 'Process/line unenrollment via Enrollment page')`,
          [enrollID, uniqueID, deptID, areaID, mCourseID, adminUniqueID],
          (logError) => {
            if (logError) console.error('Error writing enrolllogs (non-fatal):', logError);
            res.json({ success: true });
          }
        );
      }
    );
  });
});

function normalizeSkillLevelNumber(value, fallback = 2) {
  const match = String(value || '').match(/[1-4]/);
  const level = match ? Number(match[0]) : Number(value);
  return Number.isInteger(level) && level >= 1 && level <= 4 ? level : fallback;
}

function buildSkillMatrixKey(uniqueID, stationID) {
  return `${Number(uniqueID)}:${Number(stationID)}`;
}

app.get('/api/skill-matrix', async (req, res) => {
  const deptID = Number(req.query.deptID);
  const areaID = Number(req.query.areaID);
  const mCourseID = Number(req.query.mCourseID);
  const planYear = Number(req.query.year) || new Date().getFullYear();

  if (!deptID || !areaID || !mCourseID) {
    return res.status(400).json({ success: false, error: 'deptID, areaID and mCourseID are required' });
  }

  try {
    const db = connection.promise();

    const [lineRows] = await db.query(
      `SELECT d.deptName, a.areaName, m.mCourseName, m.mCourseLevel
       FROM mcourses m
       LEFT JOIN departments d ON d.deptID = m.deptID
       LEFT JOIN areas a ON a.areaID = m.areaID
       WHERE m.deptID = ? AND m.areaID = ? AND m.mCourseID = ?
       LIMIT 1`,
      [deptID, areaID, mCourseID]
    );
    if (!lineRows.length) {
      return res.status(404).json({ success: false, error: 'Line not found' });
    }

    const [stationRows] = await db.query(
      `SELECT stationID, stationName
       FROM stations
       WHERE deptID = ? AND areaID = ? AND mCourseID = ?
       ORDER BY stationName`,
      [deptID, areaID, mCourseID]
    );

    const [userRows] = await db.query(
      `SELECT DISTINCT
          u.uniqueID, u.name, u.employeeID, u.uName, u.dateOfJoining,
          es.startDate, es.enrollDate,
          es.stationID, s.stationName,
          lcu.acknowledgeDate, lcu.l2TempStartDate
       FROM enrollstatus es
       JOIN users u ON u.uniqueID = es.uniqueID
       JOIN l1completedusers lcu ON lcu.uniqueID = u.uniqueID AND lcu.l1Status = 'Pass'
       LEFT JOIN stations s ON s.stationID = es.stationID
       WHERE es.deptID = ?
         AND es.areaID = ?
         AND es.mCourseID = ?
         AND es.coMCourseID IS NULL
         AND es.subCourseID IS NULL
         AND COALESCE(es.enrollStatus, 'Active') IN ('Active', 'active', 'Enrolled', 'enrolled')
       ORDER BY u.name, es.stationID`,
      [deptID, areaID, mCourseID]
    );

    const usersByID = new Map();
    userRows.forEach(row => {
      if (!usersByID.has(row.uniqueID)) {
        usersByID.set(row.uniqueID, {
          uniqueID: row.uniqueID,
          name: row.name,
          employeeID: row.employeeID,
          uName: row.uName,
          dateOfJoining: row.dateOfJoining,
          acknowledgeDate: row.acknowledgeDate,
          startDate: row.startDate,
          enrollDate: row.enrollDate,
          l2TempStartDate: row.l2TempStartDate,
          stationIDs: [],
          currentLevelByStation: {}
        });
      }
      const user = usersByID.get(row.uniqueID);
      if (!user.startDate && row.startDate) user.startDate = row.startDate;
      if (!user.l2TempStartDate && row.l2TempStartDate) user.l2TempStartDate = row.l2TempStartDate;
      const stationID = Number(row.stationID) || 0;
      if (stationID && !user.stationIDs.includes(stationID)) {
        user.stationIDs.push(stationID);
      }
    });

    const level1Pattern = 'level 1';
    const [level1Rows] = await db.query(
      `SELECT subCourseID, subCourseName, courseType, subCourseLevel
       FROM subcourses
       WHERE (LOWER(REPLACE(COALESCE(subCourseLevel, ''), 'level', 'level ')) LIKE ?
          OR LOWER(COALESCE(subCourseLevel, '')) IN ('l1', '1', 'level1'))
       ORDER BY subCourseID`,
      [`%${level1Pattern}%`]
    );

    const [commonCourseRows] = await db.query(
      `SELECT subCourseID, subCourseName, courseType, subCourseLevel
       FROM subcourses
       WHERE mCourseID IS NULL
         AND deptID IS NULL
         AND (
          LOWER(REPLACE(COALESCE(subCourseLevel, ''), 'level', 'level ')) LIKE '%level 2%'
          OR LOWER(REPLACE(COALESCE(subCourseLevel, ''), 'level', 'level ')) LIKE '%level 3%'
          OR LOWER(REPLACE(COALESCE(subCourseLevel, ''), 'level', 'level ')) LIKE '%level 4%'
          OR LOWER(COALESCE(subCourseLevel, '')) IN ('l2', '2', 'level2', 'l3', '3', 'level3', 'l4', '4', 'level4')
         )
       ORDER BY subCourseID`,
      []
    );

    const [stationCourseRows] = await db.query(
      `SELECT subCourseID, subCourseName, courseType, subCourseLevel, COALESCE(stationID, 0) AS stationID
       FROM subcourses
       WHERE mCourseID = ?
         AND COALESCE(stationID, 0) <> 0
       ORDER BY stationID, subCourseID`,
      [mCourseID]
    );

    const stationCourseMap = stationCourseRows.reduce((map, course) => {
      const key = Number(course.stationID);
      if (!map[key]) map[key] = [];
      map[key].push(course);
      return map;
    }, {});

    const userIDs = Array.from(usersByID.keys());
    const stationSkillMap = {};
    const refresherPlanMap = {};
    if (userIDs.length) {
      const [stationSkillRows] = await db.query(
        `SELECT uniqueID, stationID, requiredLevel
         FROM skillmatrix_station_skills
         WHERE deptID = ? AND areaID = ? AND mCourseID = ? AND uniqueID IN (?)`,
        [deptID, areaID, mCourseID, userIDs]
      );
      stationSkillRows.forEach(row => {
        stationSkillMap[buildSkillMatrixKey(row.uniqueID, row.stationID)] = normalizeSkillLevelNumber(row.requiredLevel, 2);
      });

      const completedQueries = [
        { level: 2, table: 'l2completedusers', status: 'l2Status' },
        { level: 3, table: 'l3completedusers', status: 'l3Status' },
        { level: 4, table: 'l4completedusers', status: 'l4Status' }
      ].map(meta => db.query(
        `SELECT uniqueID, stationID
         FROM ${meta.table}
         WHERE mCourseID = ? AND uniqueID IN (?) AND ${meta.status} = 'Pass'`,
        [mCourseID, userIDs]
      ).then(([rows]) => ({ level: meta.level, rows })));

      const completedResults = await Promise.all(completedQueries);
      completedResults.forEach(result => {
        result.rows.forEach(row => {
          const user = usersByID.get(row.uniqueID);
          if (!user) return;
          const stationID = Number(row.stationID) || 0;
          if (stationID) {
            user.currentLevelByStation[stationID] = Math.max(user.currentLevelByStation[stationID] || 1, result.level);
          } else {
            user.stationIDs.forEach(id => {
              user.currentLevelByStation[id] = Math.max(user.currentLevelByStation[id] || 1, result.level);
            });
          }
        });
      });
      usersByID.forEach(user => {
        user.stationIDs.forEach(id => {
          if (!user.currentLevelByStation[id]) user.currentLevelByStation[id] = 1;
        });
      });

      const [refresherRows] = await db.query(
        `SELECT uniqueID, stationID, planMonth, planYear, planCode, status
         FROM skillmatrix_refresher_assignments
         WHERE deptID = ? AND areaID = ? AND mCourseID = ? AND uniqueID IN (?) AND planYear = ?`,
        [deptID, areaID, mCourseID, userIDs, planYear]
      );
      refresherRows.forEach(row => {
        const key = buildSkillMatrixKey(row.uniqueID, row.stationID);
        if (!refresherPlanMap[key]) refresherPlanMap[key] = [];
        refresherPlanMap[key].push({
          planMonth: Number(row.planMonth),
          planYear: Number(row.planYear),
          planCode: row.planCode || 'RT',
          status: row.status || 'Planned'
        });
      });
    }

    res.json({
      success: true,
      line: lineRows[0],
      stations: stationRows,
      users: Array.from(usersByID.values()),
      level1Courses: level1Rows,
      commonLevel2Courses: commonCourseRows,
      commonCourses: commonCourseRows,
      stationCourses: stationCourseMap,
      stationSkills: stationSkillMap,
      refresherPlans: refresherPlanMap,
      planYear
    });
  } catch (error) {
    console.error('Error building skill matrix:', error);
    res.status(500).json({ success: false, error: 'Database error', details: error.message });
  }
});

async function resolveSkillMatrixAdminRole(req) {
  if (!req.session?.user) return null;
  if (req.session.user.uRole) return req.session.user.uRole;
  const username = req.session.user.username;
  if (!username) return null;
  const [adminRows] = await connection.promise().query('SELECT uRole FROM admins WHERE uName = ? LIMIT 1', [username]);
  if (adminRows.length) return adminRows[0].uRole;
  const [userRows] = await connection.promise().query('SELECT uRole FROM users WHERE uName = ? LIMIT 1', [username]);
  return userRows[0]?.uRole || null;
}

function currentIndiaMonth() {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', month: 'numeric' }).format(new Date()));
}

async function validateSkillMatrix2Editing(req, res) {
  if (Number(req.body?.matrixPage) !== 2) return true;
  if (req.body?.editingEnabled !== true) {
    res.status(403).json({ success: false, error: 'Enable Editing must be switched on before changing the Skill Matrix.' });
    return false;
  }
  const role = await resolveSkillMatrixAdminRole(req);
  const month = currentIndiaMonth();
  const permitted = role === 'Super Admin' || month === 7 || month === 12;
  if (!permitted) {
    res.status(403).json({ success: false, error: 'Skill Matrix editing is available only in July and December. Super Admin can edit at any time.' });
    return false;
  }
  return true;
}

app.get('/api/skill-matrix/edit-permission', async (req, res) => {
  try {
    const role = await resolveSkillMatrixAdminRole(req);
    if (!role) return res.status(401).json({ success: false, error: 'Admin login required' });
    const currentMonth = currentIndiaMonth();
    const isSuperAdmin = role === 'Super Admin';
    res.json({
      success: true,
      role,
      isSuperAdmin,
      currentMonth,
      allowedMonths: [7, 12],
      canEnable: isSuperAdmin || currentMonth === 7 || currentMonth === 12
    });
  } catch (error) {
    console.error('Error checking Skill Matrix edit permission:', error);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

app.post('/api/skill-matrix/station-skill', express.json(), async (req, res) => {
  if (!(await validateSkillMatrix2Editing(req, res))) return;
  const uniqueID = Number(req.body?.uniqueID);
  const deptID = Number(req.body?.deptID);
  const areaID = Number(req.body?.areaID);
  const mCourseID = Number(req.body?.mCourseID);
  const stationID = Number(req.body?.stationID);
  const requiredLevel = normalizeSkillLevelNumber(req.body?.requiredLevel, 0);

  if (!uniqueID || !deptID || !areaID || !mCourseID || !stationID || requiredLevel < 2 || requiredLevel > 4) {
    return res.status(400).json({ success: false, error: 'Valid user, line, station and required level L2-L4 are required' });
  }

  try {
    await connection.promise().query(
      `INSERT INTO skillmatrix_station_skills (uniqueID, deptID, areaID, mCourseID, stationID, requiredLevel)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE requiredLevel = VALUES(requiredLevel), updatedAt = CURRENT_TIMESTAMP`,
      [uniqueID, deptID, areaID, mCourseID, stationID, requiredLevel]
    );
    res.json({ success: true, requiredLevel });
  } catch (error) {
    console.error('Error saving skill matrix station skill:', error);
    res.status(500).json({ success: false, error: 'Database error', details: error.message });
  }
});

// Add an acknowledged learner to an additional station without replacing
// the learner's existing Level 2 assignment. The normal enrollment queries
// then expose that station's courses in the learner profile.
app.post('/api/skill-matrix/multiskill-assignment', express.json(), async (req, res) => {
  const adminRole = await resolveSkillMatrixAdminRole(req);
  if (!adminRole) return res.status(401).json({ success: false, error: 'Admin login required' });
  if (!(await validateSkillMatrix2Editing(req, res))) return;

  const uniqueID = Number(req.body?.uniqueID);
  const deptID = Number(req.body?.deptID);
  const areaID = Number(req.body?.areaID);
  const mCourseID = Number(req.body?.mCourseID);
  const stationID = Number(req.body?.stationID);
  const startDate = String(req.body?.startDate || '');
  if (!uniqueID || !deptID || !areaID || !mCourseID || !stationID || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    return res.status(400).json({ success: false, error: 'Valid learner, line, station and start date are required' });
  }

  const db = connection.promise();
  try {
    const [stationRows] = await db.query(
      `SELECT stationID FROM stations WHERE stationID = ? AND deptID = ? AND areaID = ? AND mCourseID = ? LIMIT 1`,
      [stationID, deptID, areaID, mCourseID]
    );
    if (!stationRows.length) return res.status(400).json({ success: false, error: 'Selected station does not belong to this line' });

    const [ackRows] = await db.query(
      `SELECT uniqueID FROM l1completedusers WHERE uniqueID = ? AND l1Status = 'Pass' LIMIT 1`,
      [uniqueID]
    );
    if (!ackRows.length) return res.status(400).json({ success: false, error: 'Learner must pass Level 1 acknowledgement first' });

    const [activeRows] = await db.query(
      `SELECT enrollID, stationID, multiSkill
       FROM enrollstatus
       WHERE uniqueID = ? AND deptID = ? AND areaID = ? AND mCourseID = ?
         AND coMCourseID IS NULL AND subCourseID IS NULL
         AND COALESCE(enrollStatus, 'Active') IN ('Active', 'active', 'Enrolled', 'enrolled')`,
      [uniqueID, deptID, areaID, mCourseID]
    );
    if (activeRows.some(row => Number(row.stationID) === stationID)) {
      return res.status(409).json({ success: false, error: 'Learner is already assigned to this station' });
    }

    // The learner must finish the training for every existing station before
    // starting a multiskill assignment. Use the station's required level so
    // an L3 learner is checked against L3 acknowledgement, not just L2.
    const currentStations = activeRows
      .map(row => Number(row.stationID))
      .filter(Boolean);
    if (currentStations.length) {
      const [requiredRows] = await db.query(
        `SELECT stationID, requiredLevel
         FROM skillmatrix_station_skills
         WHERE uniqueID = ? AND deptID = ? AND areaID = ? AND mCourseID = ? AND stationID IN (?)`,
        [uniqueID, deptID, areaID, mCourseID, currentStations]
      );
      const requiredByStation = new Map(requiredRows.map(row => [Number(row.stationID), Math.max(2, Math.min(4, Number(row.requiredLevel) || 2))]));
      const completionTables = [
        { level: 2, table: 'l2completedusers', status: 'l2Status' },
        { level: 3, table: 'l3completedusers', status: 'l3Status' },
        { level: 4, table: 'l4completedusers', status: 'l4Status' }
      ];
      const completedByLevel = new Map();
      for (const meta of completionTables) {
        const [rows] = await db.query(
          `SELECT stationID FROM ${meta.table}
           WHERE uniqueID = ? AND mCourseID = ? AND ${meta.status} = 'Pass' AND stationID IN (?)`,
          [uniqueID, mCourseID, [0].concat(currentStations)]
        );
        rows.forEach(row => {
          const completedStation = Number(row.stationID) || 0;
          currentStations.forEach(currentStation => {
            if (completedStation === 0 || completedStation === currentStation) {
              completedByLevel.set(`${currentStation}:${meta.level}`, true);
            }
          });
        });
      }
      const incompleteStation = currentStations.find(currentStation => {
        const requiredLevel = requiredByStation.get(currentStation) || 2;
        return !completedByLevel.get(`${currentStation}:${requiredLevel}`);
      });
      if (incompleteStation) {
        const requiredLevel = requiredByStation.get(incompleteStation) || 2;
        return res.status(409).json({
          success: false,
          error: `Complete and acknowledge Level ${requiredLevel} training for the current station before multiskilling`
        });
      }
    }

    const pendingMultiSkill = activeRows.filter(row => ['yes', 'multiskill', '1'].includes(String(row.multiSkill || '').toLowerCase()));
    if (pendingMultiSkill.length) {
      const pendingIDs = pendingMultiSkill.map(row => Number(row.stationID)).filter(Boolean);
      const [passedRows] = await db.query(
        `SELECT stationID FROM l2completedusers
         WHERE uniqueID = ? AND mCourseID = ? AND l2Status = 'Pass' AND stationID IN (?)`,
        [uniqueID, mCourseID, pendingIDs]
      );
      const passedIDs = new Set(passedRows.map(row => Number(row.stationID)));
      const pendingStation = pendingIDs.find(id => !passedIDs.has(id));
      if (pendingStation) {
        return res.status(409).json({
          success: false,
          error: 'Complete and pass the current multiskill station training before assigning another station'
        });
      }
    }

    const enrollDateText = new Date().toLocaleDateString('en-GB', {});
    const [insertResult] = await db.query(
      `INSERT INTO enrollstatus
        (uniqueID, deptID, areaID, mCourseID, stationID, coMCourseID, subCourseID, enrollDate, startDate, endDate, enrollStatus, multiSkill, activeTrainingStations)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, 'Active', 'Yes', 'Yes')`,
      [uniqueID, deptID, areaID, mCourseID, stationID, enrollDateText, startDate]
    );
    await db.query(
      `INSERT INTO skillmatrix_station_skills (uniqueID, deptID, areaID, mCourseID, stationID, requiredLevel)
       VALUES (?, ?, ?, ?, ?, 2)
       ON DUPLICATE KEY UPDATE requiredLevel = GREATEST(requiredLevel, 2), updatedAt = CURRENT_TIMESTAMP`,
      [uniqueID, deptID, areaID, mCourseID, stationID]
    );
    const adminUniqueID = (req.session && req.session.user && req.session.user.uniqueID) || null;
    await db.query(
      `INSERT INTO enrolllogs
        (enrollID, uniqueID, deptID, areaID, mCourseID, coMCourseID, subCourseID, action, actionBy, remark)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, 'ENROLL_MULTISKILL', ?, ?)`,
      [insertResult.insertId, uniqueID, deptID, areaID, mCourseID, adminUniqueID, `Additional Level 2 station assignment for multiskilling (stationID ${stationID})`]
    ).catch(error => console.error('Error writing multiskill enroll log (non-fatal):', error));

    res.json({ success: true, multiSkill: true, stationID, message: 'Multiskill station assigned. Level 2 training is now available.' });
  } catch (error) {
    console.error('Error assigning multiskill station:', error);
    res.status(500).json({ success: false, error: 'Database error', details: error.message });
  }
});

app.post('/api/skill-matrix/refresher-plan', express.json(), async (req, res) => {
  if (!(await validateSkillMatrix2Editing(req, res))) return;
  const uniqueID = Number(req.body?.uniqueID);
  const deptID = Number(req.body?.deptID);
  const areaID = Number(req.body?.areaID);
  const mCourseID = Number(req.body?.mCourseID);
  const stationID = Number(req.body?.stationID);
  const planMonth = Number(req.body?.planMonth);
  const planYear = Number(req.body?.planYear) || new Date().getFullYear();
  const originalPlanMonth = Number(req.body?.originalPlanMonth);
  const originalPlanYear = Number(req.body?.originalPlanYear);
  const requestedPlanCode = String(req.body?.planCode || 'RT').trim().toUpperCase();
  const allowedPlanCodes = new Set(['RT', 'L2', 'L3', 'L4', 'L2T', 'L3T', 'L4T']);
  const planCode = requestedPlanCode === 'L2' ? 'L2T'
    : requestedPlanCode === 'L3' ? 'L3T'
      : requestedPlanCode === 'L4' ? 'L4T' : requestedPlanCode;

  if (!uniqueID || !deptID || !areaID || !mCourseID || !stationID || planMonth < 1 || planMonth > 12 || planYear < 2000) {
    return res.status(400).json({ success: false, error: 'Valid user, line, station, month and year are required' });
  }
  if (!allowedPlanCodes.has(planCode)) {
    return res.status(400).json({ success: false, error: 'Valid plan code is required' });
  }

  const plannedDate = `${planYear}-${String(planMonth).padStart(2, '0')}-01`;
  try {
    const db = connection.promise();
    await db.beginTransaction();
    if (originalPlanMonth >= 1 && originalPlanMonth <= 12 && originalPlanYear >= 2000) {
      await db.query(
        `DELETE FROM skillmatrix_refresher_assignments
         WHERE uniqueID = ? AND deptID = ? AND areaID = ? AND mCourseID = ? AND stationID = ?
           AND planMonth = ? AND planYear = ?`,
        [uniqueID, deptID, areaID, mCourseID, stationID, originalPlanMonth, originalPlanYear]
      );
    }
    await db.query(
      `INSERT INTO skillmatrix_refresher_assignments
        (uniqueID, deptID, areaID, mCourseID, stationID, planMonth, planYear, plannedDate, planCode, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Planned')
       ON DUPLICATE KEY UPDATE plannedDate = VALUES(plannedDate), planCode = VALUES(planCode), status = 'Planned', updatedAt = CURRENT_TIMESTAMP`,
      [uniqueID, deptID, areaID, mCourseID, stationID, planMonth, planYear, plannedDate, planCode]
    );
    await db.commit();
    res.json({ success: true, planMonth, planYear, planCode, status: 'Planned' });
  } catch (error) {
    await connection.promise().rollback().catch(() => {});
    console.error('Error saving skill matrix refresher plan:', error);
    res.status(500).json({ success: false, error: 'Database error', details: error.message });
  }
});

app.get('/getLevels', (req, res) => {
  const query = 'SELECT id, levelName FROM levels';

  connection.query(query, (error, results) => {
    if (error) {
      console.error('Error fetching levels:', error);
      res.status(500).json({ error: 'Internal server error' });
      return;
    }

    const levels = results.map(row => ({
      id: row.id,
      name: row.levelName
    }));

    res.json({ levels });
  });
});

// ---------------------------------------------------------------
// ADD MAIN COURSE → INSERT INTO department TABLE
// ---------------------------------------------------------------
function updateCourseMainAndLevel(req, res) {
  const { courseID, mCourseName, level } = req.body;

  if (!courseID || !String(mCourseName || '').trim() || !String(level || '').trim()) {
    return res.status(400).json({
      success: false,
      error: 'Course ID, main course, and tag are required'
    });
  }

  const query = 'UPDATE courses SET mCourseName = ?, level = ? WHERE courseID = ?';

  connection.query(query, [String(mCourseName).trim(), String(level).trim(), courseID], (error, result) => {
    if (error) {
      console.error('Error updating course main course/tag:', error);
      return res.status(500).json({
        success: false,
        error: 'Database error',
        details: error.message
      });
    }

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        error: 'Course not found'
      });
    }

    res.json({
      success: true,
      message: 'Course updated successfully'
    });
  });
}

app.put('/updateCourseMainAndLevel', express.json(), updateCourseMainAndLevel);
app.post('/updateCourseMainAndLevel', express.json(), updateCourseMainAndLevel);

app.post('/addMainCourse', express.json(), async (req, res) => {
  console.log('Received /addMainCourse →', req.body);   // ← DEBUG LOG

  const { name, description, date } = req.body;

  // Validation
  if (!name?.trim() || !description?.trim() || !date) {
    return res.status(400).json({ error: 'All fields (name, description, date) are required' });
  }

  const sql = `
    INSERT INTO department 
      (mCourseName, mCourseDiscription, mCourseDate) 
    VALUES 
      (?, ?, ?)
  `;

  connection.query(sql, [name.trim(), description.trim(), date], (err, result) => {
    if (err) {
      console.error('Error inserting into department table:', err);
      return res.status(500).json({ error: 'Database error', details: err.message });
    }

    console.log('Main Course added successfully → ID:', result.insertId);

    // Return success so frontend knows everything worked
    res.status(201).json({
      success: true,
      message: 'Main Course added successfully',
      id: result.insertId
    });
  });
});



app.get('/getUserCompletedTags', async (req, res) => {
  const { uniqueID } = req.query;

  if (!uniqueID) {
    return res.status(400).json({ 
      success: false, 
      message: 'uniqueID is required' 
    });
  }

  try {
    // Step 1: Fetch all courses with their tags and main courses
    const coursesQuery = `
      SELECT 
        c.courseID, 
        c.courseName, 
        c.mCourseName, 
        c.level as courseTag
      FROM courses c
      WHERE c.courseID IS NOT NULL
    `;

    connection.query(coursesQuery, async (err, courses) => {
      if (err) {
        console.error('Error fetching courses:', err);
        return res.status(500).json({ 
          success: false, 
          message: 'Database error' 
        });
      }

      console.log(`Found ${courses.length} courses`);

      // Step 2: Check each course if user passed (score >= 60)
      const passedCourses = [];
      
      for (const course of courses) {
        const tableName = `course_${course.courseID}`;
        
        // Query to get latest posttest score
        const scoreQuery = `
          SELECT 
            COALESCE(
              NULLIF(TRIM(course_${course.courseID}_Posttest27), ''),
              NULLIF(TRIM(course_${course.courseID}_Posttest26), ''),
              NULLIF(TRIM(course_${course.courseID}_Posttest25), ''),
              NULLIF(TRIM(course_${course.courseID}_Posttest24), ''),
              NULLIF(TRIM(course_${course.courseID}_Posttest23), ''),
              NULLIF(TRIM(course_${course.courseID}_Posttest22), ''),
              NULLIF(TRIM(course_${course.courseID}_Posttest21), ''),
              NULLIF(TRIM(course_${course.courseID}_Posttest20), ''),
              NULLIF(TRIM(course_${course.courseID}_Posttest19), ''),
              NULLIF(TRIM(course_${course.courseID}_Posttest18), ''),
              NULLIF(TRIM(course_${course.courseID}_Posttest17), ''),
              NULLIF(TRIM(course_${course.courseID}_Posttest16), ''),
              NULLIF(TRIM(course_${course.courseID}_Posttest15), ''),
              NULLIF(TRIM(course_${course.courseID}_Posttest14), ''),
              NULLIF(TRIM(course_${course.courseID}_Posttest13), ''),
              NULLIF(TRIM(course_${course.courseID}_Posttest12), ''),
              NULLIF(TRIM(course_${course.courseID}_Posttest11), ''),
              NULLIF(TRIM(course_${course.courseID}_Posttest10), ''),
              NULLIF(TRIM(course_${course.courseID}_Posttest9), ''),
              NULLIF(TRIM(course_${course.courseID}_Posttest8), ''),
              NULLIF(TRIM(course_${course.courseID}_Posttest7), ''),
              NULLIF(TRIM(course_${course.courseID}_Posttest6), ''),
              NULLIF(TRIM(course_${course.courseID}_Posttest5), ''),
              NULLIF(TRIM(course_${course.courseID}_Posttest4), ''),
              NULLIF(TRIM(course_${course.courseID}_Posttest3), ''),
              NULLIF(TRIM(course_${course.courseID}_Posttest2), ''),
              NULLIF(TRIM(course_${course.courseID}_Posttest1), '')
            ) as posttest
          FROM ${tableName} 
          WHERE uniqueID = ? 
          LIMIT 1
        `;

        try {
          const score = await new Promise((resolve, reject) => {
            connection.query(scoreQuery, [uniqueID], (error, results) => {
              if (error) {
                console.warn(`Table ${tableName} error:`, error.message);
                resolve(null);
              } else if (results.length > 0 && results[0].posttest !== null) {
                resolve(parseFloat(results[0].posttest));
              } else {
                resolve(null);
              }
            });
          });

          // If user passed (score >= 60)
          if (score !== null && score >= 60) {
            passedCourses.push({
              courseID: course.courseID,
              courseName: course.courseName,
              mCourseName: course.mCourseName,
              courseTag: course.courseTag,
              score: score
            });
          }
        } catch (error) {
          console.error(`Error checking ${tableName}:`, error);
        }
      }

      console.log(`User ${uniqueID} passed courses:`, passedCourses);

      // Step 3: Group by Main Course + Tag and check completion
      const completedTags = {};
      
      for (const course of passedCourses) {
        const mainCourse = course.mCourseName;
        const tag = course.courseTag;
        const key = `${mainCourse}|${tag}`;

        if (!completedTags[key]) {
          completedTags[key] = {
            mCourseName: mainCourse,
            tag: tag,
            passedCourses: [],
            totalCoursesInTag: 0,
            isComplete: false
          };
        }

        completedTags[key].passedCourses.push(course);
      }

      // Step 4: Check if each tag is fully completed
      for (const key in completedTags) {
        const [mCourseName, tag] = key.split('|');
        
        const totalQuery = `
          SELECT COUNT(*) as total
          FROM courses
          WHERE mCourseName = ? AND level = ?
        `;

        const total = await new Promise((resolve, reject) => {
          connection.query(totalQuery, [mCourseName, tag], (error, results) => {
            if (error) {
              console.error('Error counting courses:', error);
              resolve(0);
            } else {
              resolve(results[0].total);
            }
          });
        });

        completedTags[key].totalCoursesInTag = total;
        completedTags[key].isComplete = 
          (completedTags[key].passedCourses.length === total && total > 0);
      }

      // Step 5: Format response by main course
      const tagsByMainCourse = {};

      for (const key in completedTags) {
        const tagInfo = completedTags[key];
        const mainCourse = tagInfo.mCourseName;

        if (!tagsByMainCourse[mainCourse]) {
          tagsByMainCourse[mainCourse] = [];
        }

        if (tagInfo.isComplete) {
          tagsByMainCourse[mainCourse].push(tagInfo.tag);
        }
      }

      console.log('Completed tags by main course:', tagsByMainCourse);

      res.json({
        success: true,
        completedTagsByMainCourse: tagsByMainCourse,
        details: completedTags
      });
    });

  } catch (error) {
    console.error('Error in getUserCompletedTags:', error);
    return res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
});

app.post("/uploadTraining", uploadFiles, (req, res) => {
  console.log("Files received:", req.files);
  console.log("Body received:", req.body);

  let { courseID, courseName, courseDescription, courseDate, level, mCourseName, RT_Date } = req.body;

  const mcqFile = req.files.mcqFile?.[0];
  const videoFile = req.files["videoFile"]?.[0];

  if (!mcqFile) {
    return res.status(400).send("MCQ file is missing!");
  }

  // --- NEW: Dynamic Folder Creation and Path Definition ---
  const courseFolder = `${courseID}_course`;
  const baseUploadDir = path.join(__dirname, "uploads", "Training Assessment", "Posttest assessment");
  const coursePath = path.join(baseUploadDir, courseFolder);

  // Ensure the course-specific folder exists
  if (!fs.existsSync(coursePath)) {
    fs.mkdirSync(coursePath, { recursive: true });
    console.log(`Course directory created at: ${coursePath}`);
  }

  // Define new file paths within the dynamic folder
  const mcqFilePath = path.join(coursePath, `${Date.now()}_${mcqFile.originalname}`);
  const videoFilePath = videoFile
    ? path.join(coursePath, `${courseID}_video.mp4`)
    : null;
  // --- END NEW: Dynamic Folder Creation and Path Definition ---

  try {
    // Save MCQ file to the new location
    fs.writeFileSync(mcqFilePath, mcqFile.buffer);
    console.log(`MCQ file saved at: ${mcqFilePath}`);

    if (!fs.existsSync(mcqFilePath)) {
      throw new Error("MCQ file path is invalid!");
    }

    // Handle video file saving to the new location
    if (videoFile) {
      fs.writeFileSync(videoFilePath, videoFile.buffer);
      console.log(`Video file saved at: ${videoFilePath}`);
    }

    // Read the uploaded Excel file
    const workbook = xlsx.readFile(mcqFilePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];

    // Parse the worksheet data into JSON
    const jsonData = xlsx.utils.sheet_to_json(worksheet);

    // Set courseTags to "default" if it is not provided
    if (!level || level.trim() === '') {
      level = 'default';
    }

    const refreshalMonths = RT_Date;
    RT_Date = calculateRefreshalDate(courseDate, refreshalMonths);

    if (RT_Date) {
      console.log(`Calculated RT_Date: ${RT_Date} (${refreshalMonths} months from ${courseDate})`);
    }

    // Read the HTML template
    const templatePath = path.join(__dirname, "public", "trainingAss_Template.html");
    let template = fs.readFileSync(templatePath, "utf-8");

    // --- NEW: Update scormPath to the new dynamic folder ---
    const uploadPath = `uploads/Training Assessment/Posttest assessment/${courseFolder}`;

    insertNormalizedSubcourseFromUpload(
      { ...req.body, courseID, courseName, courseDescription, courseDate, level, mCourseName, RT_Date: refreshalMonths },
      uploadPath,
      videoFile ? 'assessment' : 'assessment',
      videoFile ? 'video_with_excel' : 'excel',
      (normalizedError, normalizedResult, usedNormalizedSchema) => {
        if (normalizedError && !shouldFallbackToLegacySchema(normalizedError)) {
          console.error('Error saving normalized training course:', normalizedError);
          return res.status(500).send(normalizedError.message || 'Error saving normalized course');
        }

        if (!usedNormalizedSchema) {
          continueLegacyTrainingUpload();
          return;
        }

        let quizQuestions = "";
        jsonData.forEach((row, index) => {
          const answerKey = {
            'A': row.option1Text,
            'B': row.option2Text,
            'C': row.option3Text,
            'D': row.option4Text
          };
          const correctAnswerText = answerKey[String(row.answerText).trim().toUpperCase()];

          const escapeAttr = (text) => String(text).replace(/"/g, '&quot;');
          const escapeHTML = (text) => String(text);

          quizQuestions += `
                       <div class="question" data-question-number="${index + 1}" data-correct-answer="${escapeAttr(correctAnswerText)}">
                            <p><strong>${index + 1}. ${escapeHTML(row.questionText)}</strong></p>
                            <label><input type="radio" name="question${index}" value="${escapeAttr(row.option1Text)}"> ${escapeHTML(row.option1Text)}</label><br>
                            <label><input type="radio" name="question${index}" value="${escapeAttr(row.option2Text)}"> ${escapeHTML(row.option2Text)}</label><br>
                            <label><input type="radio" name="question${index}" value="${escapeAttr(row.option3Text)}"> ${escapeHTML(row.option3Text)}</label><br>
                            <label><input type="radio" name="question${index}" value="${escapeAttr(row.option4Text)}"> ${escapeHTML(row.option4Text)}</label><br>
                       </div>
                    `;
        });

        const finalQuizHTML = template
          .replace(/{{courseName}}/g, courseName)
          .replace(/{{courseID}}/g, normalizedResult.insertId)
          .replace(/{{quizQuestions}}/g, quizQuestions);

        const htmlFilePath = path.join(coursePath, `${normalizedResult.insertId}_quiz.html`);
        fs.writeFileSync(htmlFilePath, finalQuizHTML);
        persistSubcourseQuestions(normalizedResult.insertId, jsonData);

        return res.send(`
                    <p>File uploaded and quiz generated successfully!</p>
                    <script>
                        const uploadConfirmation = confirm('Course uploaded successfully.');
                        if (uploadConfirmation) {
                            window.location.href = '/courseManagement.html';
                        }
                    </script>
                `);
      }
    );

    function continueLegacyTrainingUpload() {
    const query = `INSERT INTO courses (courseName, courseDescription, courseDate, scormPath, courseID, level, mCourseName, RT_Date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
    connection.query(query, [courseName, courseDescription, courseDate, uploadPath, courseID, level, mCourseName, RT_Date], (error, results) => {
      if (error) {
        console.error('Error saving course data:', error);
        return res.status(500).send('Internal Server Error');
      }
      console.log('Course data saved successfully');

      // Dynamically create column definitions
      let columnDefinitions = `
                id INT AUTO_INCREMENT PRIMARY KEY,
                uniqueID VARCHAR(255) NOT NULL,
                employeeID TEXT,
                name TEXT,
                noOfAttempts INT DEFAULT 0
            `;

      for (let i = 1; i <= 27; i++) {
        columnDefinitions += `,
                    course_${courseID}_Posttest${i} LONGTEXT,
                    score${i} LONGTEXT,
                    status${i} LONGTEXT,
                    duration${i} LONGTEXT,
                    date${i} TEXT
                `;
      }

      const createTableQuery = `CREATE TABLE IF NOT EXISTS course_${courseID} (${columnDefinitions});`;

      connection.query(createTableQuery, (err) => {
        if (err) {
          console.error('Error creating course table:', err);
          return res.status(500).send('Error creating course table');
        }
        console.log(`Table course_${courseID} created successfully`);

        // ----------------------------------------------
        // COMMENTED OUT: Auto-insert all users into the course table
        // const selectUsersQuery = `SELECT uniqueID, employeeID, name FROM users`;
        // connection.query(selectUsersQuery, (err, users) => {
        //     if (err) {
        //         console.error('Error fetching users data:', err);
        //         return res.status(500).send('Error fetching users data');
        //     }
        //     const insertUserData = `INSERT INTO course_${courseID} (uniqueID, employeeID, name) VALUES ?`;
        //     const userData = users.map(user => [user.uniqueID, user.employeeID, user.name]);
        //     connection.query(insertUserData, [userData], (err) => {
        //         if (err) {
        //             console.error('Error inserting user data:', err);
        //             return res.status(500).send('Error inserting user data');
        //         }
        //         console.log(`User data inserted into course_${courseID} successfully`);
        //     });
        // });
        // ----------------------------------------------

        // --- Generate Quiz HTML from Excel ---
        let quizQuestions = "";
        jsonData.forEach((row, index) => {
          const answerKey = {
            'A': row.option1Text,
            'B': row.option2Text,
            'C': row.option3Text,
            'D': row.option4Text
          };
          const correctAnswerText = answerKey[String(row.answerText).trim().toUpperCase()];

          const escapeAttr = (text) => String(text).replace(/"/g, '&quot;');
          const escapeHTML = (text) => String(text);

          quizQuestions += `
                       <div class="question" data-question-number="${index + 1}" data-correct-answer="${escapeAttr(correctAnswerText)}">
                            <p><strong>${index + 1}. ${escapeHTML(row.questionText)}</strong></p>
                            <label><input type="radio" name="question${index}" value="${escapeAttr(row.option1Text)}"> ${escapeHTML(row.option1Text)}</label><br>
                            <label><input type="radio" name="question${index}" value="${escapeAttr(row.option2Text)}"> ${escapeHTML(row.option2Text)}</label><br>
                            <label><input type="radio" name="question${index}" value="${escapeAttr(row.option3Text)}"> ${escapeHTML(row.option3Text)}</label><br>
                            <label><input type="radio" name="question${index}" value="${escapeAttr(row.option4Text)}"> ${escapeHTML(row.option4Text)}</label><br>
                       </div>
                    `;
        });

        // Replace placeholders in the template
        const finalQuizHTML = template
          .replace(/{{courseName}}/g, courseName)
          .replace(/{{courseID}}/g, courseID)
          .replace(/{{quizQuestions}}/g, quizQuestions);

        // Save HTML file to the new location
        const htmlFilePath = path.join(coursePath, `${courseID}_quiz.html`);
        fs.writeFileSync(htmlFilePath, finalQuizHTML);
        persistSubcourseQuestions(courseID, jsonData);

        // Send final response
        res.send(`
                    <p>File uploaded and quiz generated successfully!</p>
                    <a href="/">Upload another file</a> | 
                    <a href="/training/${courseID}">View Quiz</a>
                    <script>
                        const uploadConfirmation = confirm('Course uploaded and table created successfully.');
                        if (uploadConfirmation) {
                            window.location.href = '/createCourse.html';
                        }
                    </script>
        `);
      });
    });
    }
  }
  catch (err) {
    console.error("Error processing files:", err);
    res.status(500).send("Error processing uploaded files.");
  }
});



app.post("/submitScore/:courseID", (req, res) => {
  const { courseID } = req.params;
  const { score, status, uniqueID, courseName } = req.body;

  if (!uniqueID) return res.status(400).send("uniqueID is required");

  const tableName = `course_${courseID}`;
  const coursePosttestColumn = `course${courseID}Posttest`;
  const courseTrainDateColumn = `course${courseID}TrainDate`;
  const uCourseColumn = `uCourse${courseID}`;

  const updateCourseQuery = `
        UPDATE ?? 
        SET score1 = ?, status1 = ?, date1 = NOW() 
        WHERE uniqueID = ?`;

  connection.query(updateCourseQuery, [tableName, score, status, uniqueID], (err) => {
    if (err) {
      console.error("Error updating course table:", err);
      return res.status(500).send("DB update error");
    }

    const updateUserQuery = `
            UPDATE users
            SET ?? = ?, ?? = ?, ?? = NOW()
            WHERE uniqueID = ?`;

    connection.query(updateUserQuery, [
      uCourseColumn, courseName,
      coursePosttestColumn, score,
      courseTrainDateColumn, uniqueID
    ], (err2) => {
      if (err2) {
        console.error("Error updating users table:", err2);
        return res.status(500).send("DB update error users table");
      }

      res.send({ success: true });
    });
  });
});


app.get('/api/get-current-user', (req, res) => {
  if (!req.session || !req.session.user || !req.session.user.uniqueID) {
    return res.status(401).json({ error: 'User not authenticated' });
  }

  const uniqueID = req.session.user.uniqueID;

  // Query to get user details
  const query = 'SELECT uniqueID, employeeID, name FROM users WHERE uniqueID = ? LIMIT 1';

  connection.query(query, [uniqueID], (error, results) => {
    if (error) {
      console.error('Error fetching user data:', error);
      return res.status(500).json({ error: 'Database error' });
    }

    if (results.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(results[0]); // Return user data: uniqueID, employeeID, name
  });
});


app.post("/updateScore", (req, res) => {
  const { courseID, userUniqueID, score } = req.body;

  if (!courseID || !userUniqueID) {
    return res.status(400).json({ success: false, error: "Missing courseID or userUniqueID" });
  }

  const tableName = `course_${courseID}`;

  const sql = `
        UPDATE ${tableName}
        SET score1 = ?, status1 = 'completed', date1 = NOW()
        WHERE uniqueID = ?
    `;

  connection.query(sql, [score, userUniqueID], (err, result) => {
    if (err) {
      console.error("Error updating score:", err);
      return res.json({ success: false, error: err.message });
    }
    res.json({ success: true });
  });
});



//New Code for wheh user clicks on name then userdata.html open start here 
app.get('/UserDataAd', (req, res) => {
  const uniqueID = req.query.uniqueID;

  if (!uniqueID) {
    return res.status(400).json({ error: "uniqueID is required" });
  }

  // Use SELECT * so this stays correct regardless of which optional columns
  // exist on the users table (the explicit column list here previously
  // referenced columns - currentDate, status, contractorName - that don't
  // exist on this schema and caused ER_BAD_FIELD_ERROR).
  const query = `SELECT * FROM users WHERE uniqueID = ? LIMIT 1`;

  connection.query(query, [uniqueID], (err, results) => {
    if (err) {
      console.error("Error fetching user:", err);
      return res.status(500).json({ error: "Database error" });
    }

    if (results.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    // ✅ Return single object (not array)
    res.json(results[0]);
  });
});

//New Code for wheh user clicks on name then userdata.html open end here


// Route to serve the generated HTML quiz page
app.get("/training/:courseID", (req, res) => {
  const htmlFilePath = path.join(__dirname, "uploads", "Training Assessment", "Posttest assessment", "training pages", `${req.params.courseID}_quiz.html`);
  if (fs.existsSync(htmlFilePath)) {
    res.sendFile(htmlFilePath);
  } else {
    res.status(404).send("Quiz not found.");
  }
});

//Function for search user functionality 23-07-25
app.get('/searchUsers', (req, res) => {
  const searchTerm = req.query.term;
  const query = `
    SELECT uniqueID, name, emailID, employeeID, uName, uPass, mobileNo, dateOfBirth, address, photo, dateOfJoining, department, Contract, Qualification, uRole, currentDate
    FROM users
    WHERE name LIKE ? OR emailID LIKE ? OR employeeID LIKE ? OR uName LIKE ? OR uPass LIKE ? OR mobileNo LIKE ? OR dateOfBirth LIKE ? OR address LIKE ? OR department LIKE ? OR Contract LIKE ? OR Qualification LIKE ? OR uRole LIKE ? OR currentDate LIKE ?
  `;

  const wildcardTerm = `%${searchTerm}%`;
  const params = Array(13).fill(wildcardTerm);

  connection.query(query, params, (err, results) => {
    if (err) {
      console.error('Search query failed:', err);
      return res.status(500).send('Internal Server Error');
    }
    res.json(results);
  });
});

app.get('/api/admins', (req, res) => {
  const query = `
    SELECT uniqueID, name, emailID, employeeID, uName, uPass, uRole, registerDate, registerTime
    FROM admins
    ORDER BY uniqueID DESC
  `;
  connection.query(query, (error, admins) => {
    if (error) {
      console.error('Error fetching admins:', error);
      return res.status(500).json({ success: false, error: 'Database error', details: error.message });
    }
    res.json({ success: true, admins });
  });
});

app.post('/api/admins', express.json(), (req, res) => {
  const { name, emailID, employeeID, uName, uPass, uRole } = req.body;
  if (!String(name || '').trim()) {
    return res.status(400).json({ success: false, error: 'Admin name is required' });
  }
  if (!String(uName || '').trim() || !String(uPass || '').trim()) {
    return res.status(400).json({ success: false, error: 'User ID and Password are required' });
  }
  const allowedAdminRoles = ['Admin', 'P.V./T.L.', 'Super Admin'];
  const normalizedRole = String(uRole || 'Admin').trim();
  if (!allowedAdminRoles.includes(normalizedRole)) {
    return res.status(400).json({ success: false, error: 'Invalid administrator role' });
  }

  const nowDate = new Date().toLocaleDateString('en-GB', {});
  const nowTime = new Date().toLocaleTimeString('en-US', {});
  const query = `
    INSERT INTO admins
      (name, emailID, employeeID, uName, uPass, uRole, registerDate, registerTime)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `;

  connection.query(
    query,
    [name, emailID || null, employeeID || null, uName, uPass, normalizedRole, nowDate, nowTime],
    (error, result) => {
      if (error) {
        console.error('Error saving admin:', error);
        return res.status(500).json({ success: false, error: 'Database error', details: error.message });
      }
      res.json({ success: true, uniqueID: result.insertId });
    }
  );
});

// Update an administrator's profile and credentials from Admin Management.
app.put('/api/admins/:uniqueID', express.json(), (req, res) => {
  const { name, emailID, employeeID, uName, uPass, uRole } = req.body;
  if (!String(name || '').trim()) {
    return res.status(400).json({ success: false, error: 'Admin name is required' });
  }
  if (!String(uName || '').trim() || !String(uPass || '').trim()) {
    return res.status(400).json({ success: false, error: 'User ID and Password are required' });
  }
  const allowedAdminRoles = ['Admin', 'P.V./T.L.', 'Super Admin'];
  const normalizedRole = String(uRole || 'Admin').trim();
  if (!allowedAdminRoles.includes(normalizedRole)) {
    return res.status(400).json({ success: false, error: 'Invalid administrator role' });
  }

  const query = `
    UPDATE admins
    SET name = ?, emailID = ?, employeeID = ?, uName = ?, uPass = ?, uRole = ?
    WHERE uniqueID = ?
  `;
  connection.query(
    query,
    [name.trim(), emailID || null, employeeID || null, uName.trim(), uPass, normalizedRole, req.params.uniqueID],
    (error, result) => {
      if (error) {
        console.error('Error updating admin:', error);
        return res.status(500).json({ success: false, error: 'Database error', details: error.message });
      }
      if (!result.affectedRows) return res.status(404).json({ success: false, error: 'Admin not found' });
      res.json({ success: true });
    }
  );
});

app.delete('/api/admins/:uniqueID', (req, res) => {
  connection.query('DELETE FROM admins WHERE uniqueID = ?', [req.params.uniqueID], (error, result) => {
    if (error) {
      console.error('Error deleting admin:', error);
      return res.status(500).json({ success: false, error: 'Database error', details: error.message });
    }
    res.json({ success: true, deleted: result.affectedRows });
  });
});









//backup data

// Function to convert an array of objects into a CSV string
const convertToCsv = (data) => {
  if (!data || data.length === 0) {
    return '';
  }

  // Get the headers from the keys of the first object
  const headers = Object.keys(data[0]);
  const headerRow = headers.join(',');

  // Map each object to a row of comma-separated values
  const dataRows = data.map(row => {
    return headers.map(header => {
      // Ensure values with commas or quotes are properly escaped
      const value = row[header] === null || row[header] === undefined ? '' : String(row[header]);
      return `"${value.replace(/"/g, '""')}"`;
    }).join(',');
  });

  return `${headerRow}\n${dataRows.join('\n')}`;
};

// Function to convert an array of objects into a series of SQL INSERT statements
const convertToSql = (data, tableName) => {
  if (!data || data.length === 0) {
    return '';
  }

  const headers = Object.keys(data[0]);
  const columnNames = headers.map(h => `\`${h}\``).join(', ');
  const sqlStatements = data.map(row => {
    const values = headers.map(header => {
      const value = row[header];
      if (value === null || value === undefined) {
        return 'NULL';
      } else if (typeof value === 'string') {
        // Escape single quotes for SQL
        return `'${value.replace(/'/g, "''")}'`;
      } else {
        return value;
      }
    }).join(', ');
    return `INSERT INTO \`${tableName}\` (${columnNames}) VALUES (${values});`;
  });

  return sqlStatements.join('\n');
};

// Function to get all table names from the database
const getAllTableNames = async () => {
  const [rows] = await connection.promise().query('SHOW TABLES');
  // The table names are in the first column of the result set
  const tableNames = rows.map(row => Object.values(row)[0]);
  return tableNames;
};

// API endpoint to download data as CSV
app.get('/api/backup/csv', async (req, res) => {
  try {
    const tableNames = await getAllTableNames();
    let allCsvData = '';

    for (const tableName of tableNames) {
      // Fetch data for the current table
      const [rows] = await connection.promise().query(`SELECT * FROM \`${tableName}\``);

      // Add a header for each table in the CSV
      allCsvData += `\n\n# --- TABLE: ${tableName} ---\n`;
      allCsvData += convertToCsv(rows);
    }

    // Set the appropriate headers for a CSV file download
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="database_backup.csv"');

    // Send the generated CSV data
    res.send(allCsvData);

  } catch (error) {
    console.error('Error during CSV backup:', error);
    res.status(500).send('An error occurred during CSV backup.');
  }
});

// API endpoint to download data as SQL
app.get('/api/backup/sql', async (req, res) => {
  try {
    const tableNames = await getAllTableNames();
    let allSqlData = '-- Database Backup\n\n';

    for (const tableName of tableNames) {
      // Fetch data for the current table
      const [rows] = await connection.promise().query(`SELECT * FROM \`${tableName}\``);

      // Add a comment header for each table in the SQL file
      allSqlData += `--\n-- Data for table: \`${tableName}\`\n--\n`;
      allSqlData += convertToSql(rows, tableName);
      allSqlData += '\n\n'; // Add spacing between tables
    }

    // Set the appropriate headers for a SQL file download
    res.setHeader('Content-Type', 'application/sql');
    res.setHeader('Content-Disposition', 'attachment; filename="database_backup.sql"');

    // Send the generated SQL data
    res.send(allSqlData);

  } catch (error) {
    console.error('Error during SQL backup:', error);
    res.status(500).send('An error occurred during SQL backup.');
  }
});


app.post('/api/grades/download/csv', (req, res) => {
  try {
    const gradesData = req.body;

    if (!gradesData || gradesData.length === 0) {
      return res.status(400).send('No data provided for download.');
    }

    const csvData = convertToCsv(gradesData);

    // Set the response headers to trigger a file download in the browser.
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="filtered_grades_data.csv"`);
    res.send(csvData);

  } catch (error) {
    console.error('Error during all grades backup:', error);
    res.status(500).send('An error occurred during all grades backup.');
  }
});




app.post('/api/grades/monthly/csv', (req, res) => {
  try {
    const gradesData = req.body;

    if (!gradesData || gradesData.length === 0) {
      return res.status(400).send('No monthly data provided for download.');
    }

    // The filename can be dynamic based on the data sent from the client
    const filename = `monthly_grades.csv`;

    const csvData = convertToCsv(gradesData);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csvData);

  } catch (error) {
    console.error('Error during monthly CSV download:', error);
    res.status(500).send('An error occurred during monthly CSV download.');
  }
});



// extra work for the download

app.get('/api/users-csv', (req, res) => {
  connection.query(`
    SELECT
      uniqueID, name, emailID, employeeID, uName, uPass, mobileNo, dateOfBirth, address,
      dateOfJoining, department, contract, qualification, uRole, registerDate, registerTime, userTags
    FROM users
    ORDER BY uniqueID DESC
  `, (err, results) => {
    if (err) {
      console.error('DB error:', err);
      return res.status(500).send('Database error');
    }

    if (!results || results.length === 0) {
      return res.status(404).send('No user data found');
    }

    try {
      const fields = ['uniqueID', 'name', 'emailID', 'employeeID', 'uName', 'uPass', 'mobileNo', 'dateOfBirth', 'address', 'dateOfJoining', 'department', 'contract', 'qualification', 'uRole', 'registerDate', 'registerTime', 'userTags'];
      const parser = new Parser({ fields });
      const csv = parser.parse(results);

      res.header('Content-Type', 'text/csv');
      res.attachment('users_data.csv');
      res.send(csv);
    } catch (csvErr) {
      console.error('CSV error:', csvErr);
      res.status(500).send('CSV generation failed');
    }
  });
});

//route for the saving data from the user profile date 3/10/2025
app.put('/updateUserData', (req, res) => {
  // Destructure fields from the request body (sent as x-www-form-urlencoded)
  const {
    uniqueID,
    name,
    emailID,
    employeeID,
    uName,
    uPass,
    mobileNo,
    dateOfBirth,
    address,
    dateOfJoining,
    department,
    qualification,
    contract,
    uRole,
    userTags,
    newPhotoName // Contains the new filename OR the original filename
  } = req.body;

  // Basic validation
  if (!uniqueID || !uName || !uPass) {
    return res.status(400).json({ error: 'Missing critical user fields (ID, Username, or Password).' });
  }

  // SQL UPDATE statement
  const query = `
        UPDATE users SET
            name = ?,
            emailID = ?,
            employeeID = ?,
            uName = ?,
            uPass = ?,
            mobileNo = ?,
            dateOfBirth = ?,
            address = ?,
            dateOfJoining = ?,
            department = ?,
            qualification = ?,
            contract = ?,
            uRole = ?,
            userTags = ?,
            photo = ?
        WHERE uniqueID = ?
    `;

  // Parameters for the SQL query
  const params = [
    name,
    emailID,
    employeeID,
    uName,
    uPass,
    mobileNo,
    dateOfBirth,
    address,
    dateOfJoining,
    department,
    qualification,
    contract,
    uRole,
    userTags,
    newPhotoName,
    uniqueID // WHERE clause identifier
  ];

  connection.query(query, params, (error, results) => {
    if (error) {
      console.error('Database error during user update:', error);
      if (error.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'Username or Employee ID already exists.' });
      }
      return res.status(500).json({ error: 'Internal Server Error while updating user data.' });
    }

    if (results.affectedRows === 0) {
      // User not found or no fields were actually changed
      return res.status(404).json({ error: 'User not found or no changes made.' });
    }

    console.log(`User ${uniqueID} updated successfully with photo: ${newPhotoName}`);
    res.json({ message: 'User data updated successfully.' });
  });
});



app.get('/download-training-report', (req, res) => {
  const { date } = req.query; // YYYY-MM-DD

  if (!date) {
    return res.status(400).json({ error: "Date parameter is required (format: YYYY-MM-DD)" });
  }

  // Maximum number of courses (adjust if you add more later)
  const maxCourses = 50;

  let unions = [];
  for (let i = 1; i <= maxCourses; i++) {
    unions.push(`
      SELECT uniqueID, name, emailID, employeeID, department, uRole,
             uCourse${i} AS courseName,
             course${i}TrainDate AS trainDate,
             course${i}Posttest AS score
      FROM users
      WHERE DATE(course${i}TrainDate) = ?
    `);
  }

  // Join all UNION queries
  const query = unions.join(" UNION ALL ");

  // Build parameter array → repeat `date` for each course
  const params = Array(maxCourses).fill(date);

  connection.query(query, params, (err, results) => {
    if (err) {
      console.error("Error fetching report:", err);
      return res.status(500).json({ error: "Internal Server Error" });
    }

    if (!results.length) {
      return res.json({ message: "No users found for this date" });
    }

    // Convert results into worksheet
    const worksheetData = [
      [
        "User ID",
        "Name",
        "Email",
        "Employee ID",
        "Department",
        "Role",
        "Course",
        "Training Date",
        "Score",
      ],
      ...results.map(row => [
        row.uniqueID,
        row.name,
        row.emailID,
        row.employeeID,
        row.department,
        row.uRole,
        row.courseName,
        row.trainDate ? new Date(row.trainDate).toISOString().slice(0, 10) : "",
        row.score,
      ])
    ];

    const worksheet = xlsx.utils.aoa_to_sheet(worksheetData);
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, "Training Report");

    // Generate buffer
    const buffer = xlsx.write(workbook, { type: "buffer", bookType: "xlsx" });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=Training_Report_${date}.xlsx`
    );

    res.send(buffer);
  });
});

//contract users backend routes 

// Save single contract user
app.post('/save-contract-user', async (req, res) => {
  let {
    name, dateOfJoining, mobileNo, Contract
  } = req.body;

  const uniqueID = uuidv4();

  // Use photo filename from frontend if available
  const photoFileName = req.body.photoFileName || 'default.png';
  const photo_filename = path.join(__dirname, 'public', 'photos', photoFileName);

  try {
    await connection.promise().query(
      `INSERT INTO users 
      (id, uniqueID, name, dateOfJoining, mobileNo, Contract, photo, photo_filename, currentDate) 
      VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uniqueID, name, dateOfJoining, mobileNo, Contract,
        photoFileName, photo_filename, new Date()
      ]
    );

    res.json({
      success: true,
      message: "Contract user uploaded successfully!",
      uploadedUser: { uniqueID, name, photoFileName }
    });

  } catch (error) {
    console.error('Error saving contract user:', error);
    res.status(500).json({ error: 'An error occurred while saving the contract user' });
  }
});


// Verify if name already exists
app.post('/verify-name', (req, res) => {
  const { name } = req.body;

  if (!name) return res.status(400).json({ error: 'Name is required' });

  const query = 'SELECT COUNT(*) AS count FROM users WHERE name = ?';
  connection.query(query, [name], (err, result) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Database query failed' });
    }

    const count = result[0].count;
    res.json({ exists: count > 0 });
  });
});




app.post('/upload-bulk-contract-users', upload.single('bulkUsersFile'), (req, res) => {
  if (!req.file) return res.status(400).send({ error: 'No file uploaded.' });

  const workbook = xlsx.readFile(req.file.path);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const usersData = xlsx.utils.sheet_to_json(sheet); // expects: name, dateOfJoining, mobileNo, Contract

  // Check database duplicates
  const namesInExcel = usersData.map(u => u.name);
  const query = `SELECT name FROM users WHERE name IN (?)`;
  connection.query(query, [namesInExcel], (err, results) => {
    if (err) return res.status(500).send({ error: 'DB error' });

    const existingNames = results.map(r => r.name);

    // Mark duplicates in Excel
    usersData.forEach(u => {
      if (existingNames.includes(u.name)) u.duplicateType = 'db';
      else u.duplicateType = 'none';
    });

    res.json({ users: usersData }); // frontend can show duplicates and let admin confirm
  });
});




app.post('/confirm-bulk-contract-users', express.json(), (req, res) => {
  const users = req.body.users.filter(u => u.duplicateType === 'none');

  if (!users.length) return res.send('No valid users to upload.');

  users.forEach(user => {
    const uniqueID = uuidv4();
    const query = `INSERT INTO users (name, dateOfJoining, mobileNo, Contract, uniqueID, currentDate) 
                   VALUES (?, ?, ?, ?, ?, ?)`;
    connection.query(query, [
      user.name, user.dateOfJoining, user.mobileNo, user.Contract,
      uniqueID, new Date()
    ], err => {
      if (err) console.error('Insert error:', err);
    });
  });

  res.send('Contract users uploaded successfully.');
});


// Add this new route to your main Express server file

// app.post("/submitPosttestData", express.json(), (req, res) => {
//   let { courseID, uniqueID, employeeID, name, score, duration, date, allAnswersJson } = req.body;

//   // Sanitization
//   uniqueID = uniqueID ? uniqueID.trim() : '';

//   if (!courseID || !uniqueID || score === undefined) {
//     console.error("Missing required data. uniqueID:", uniqueID);
//     return res.status(400).send("Missing required submission data");
//   }

//   const courseTable = `course_${courseID}`;
//   const status = score >= 40 ? 'passed' : 'failed'; // Adjust threshold as needed

//   // Check if user exists in course table
//   const checkEnrollmentQuery = `SELECT noOfAttempts FROM ${courseTable} WHERE uniqueID = ?`;

//   connection.query(checkEnrollmentQuery, [uniqueID], (err, results) => {
//     if (err) {
//       console.error('Database error:', err);
//       return res.status(500).send('Database error');
//     }

//     if (results.length === 0) {
//       // ✅ USER NOT ENROLLED - Insert them first
//       const insertQuery = `INSERT INTO ${courseTable} (uniqueID, employeeID, name, noOfAttempts) VALUES (?, ?, ?, 0)`;
//       connection.query(insertQuery, [uniqueID, employeeID, name], (insertErr) => {
//         if (insertErr) {
//           console.error('Error enrolling user:', insertErr);
//           return res.status(500).send('Error enrolling user in course');
//         }
//         // Now proceed with attempt update (use 1 as first attempt)
//         updateAttemptData(1);
//       });
//     } else {
//       // User exists, get current attempts
//       const currentAttempts = results[0].noOfAttempts;
//       const newAttempt = currentAttempts + 1;

//       if (newAttempt > 27) {
//         return res.status(400).send('Maximum attempts (27) reached');
//       }

//       updateAttemptData(newAttempt);
//     }

//     function updateAttemptData(attemptNum) {
//       const updateCourseQuery = `
//                 UPDATE ${courseTable} 
//                 SET noOfAttempts = ?, 
//                     course_${courseID}_Posttest${attemptNum} = ?, 
//                     score${attemptNum} = ?, 
//                     status${attemptNum} = ?, 
//                     duration${attemptNum} = ?, 
//                     date${attemptNum} = ?
//                 WHERE uniqueID = ?
//             `;

//       connection.query(updateCourseQuery, [attemptNum, allAnswersJson, score, status, duration, date, uniqueID], (err) => {
//         if (err) {
//           console.error('Error updating course table:', err);
//           return res.status(500).send('Error updating course data');
//         }

//         // Update users table
//         const updateUsersQuery = `
//                     UPDATE users 
//                     SET course${courseID}Posttest = ?, 
//                         course${courseID}TrainDate = ?, 
//                         uCourse${courseID} = ?
//                     WHERE uniqueID = ?
//                 `;

//         connection.query(updateUsersQuery, [score, date, name, uniqueID], (err2) => {
//           if (err2) {
//             console.error('Error updating users table:', err2);
//             return res.status(500).send('Error updating user data');
//           }

//           console.log(`✅ Posttest data saved successfully for attempt ${attemptNum}`);
//           res.status(200).send(`Posttest submitted successfully. Attempt: ${attemptNum}`);
//         });
//       });
//     }

//   });
// });
// ============================================
// LEVEL CRITERIA ROUTES - Place these OUTSIDE other routes
// Add this section BEFORE app.listen() at the end of your file
// ============================================

const CRITERIA_FILE_PATH = path.join(__dirname, 'data', 'levelCriteria.json');

// Default criteria
const DEFAULT_CRITERIA = {
  L1: { min: 0, max: 85, result: 'FAIL', class: 'level-L1' },
  L2: { min: 86, max: 90, result: 'PASS', class: 'level-L2' },
  L3: { min: 91, max: 95, result: 'PASS', class: 'level-L3' },
  L4: { min: 96, max: 100, result: 'PASS', class: 'level-L4' }
};

// Ensure data directory exists
async function ensureDataDirectory() {
  const dataDir = path.join(__dirname, 'data');
  try {
    await fs.promises.access(dataDir);
  } catch {
    await fs.promises.mkdir(dataDir, { recursive: true });
  }
}

// GET endpoint to retrieve level criteria
app.get('/getLevelCriteria', async (req, res) => {
  try {
    await ensureDataDirectory();

    // Try to read existing criteria file
    try {
      const data = await fs.promises.readFile(CRITERIA_FILE_PATH, 'utf8');
      const criteria = JSON.parse(data);
      res.json({ success: true, criteria: criteria });
    } catch (error) {
      // If file doesn't exist, return default criteria
      if (error.code === 'ENOENT') {
        res.json({ success: true, criteria: DEFAULT_CRITERIA });
      } else {
        throw error;
      }
    }
  } catch (error) {
    console.error('Error reading level criteria:', error);
    res.status(500).json({
      success: false,
      message: 'Error reading level criteria',
      criteria: DEFAULT_CRITERIA
    });
  }
});

// POST endpoint to save level criteria
app.post('/saveLevelCriteria', async (req, res) => {
  try {
    const { criteria } = req.body;

    if (!criteria) {
      return res.status(400).json({
        success: false,
        message: 'No criteria provided'
      });
    }

    // Validate criteria structure
    const requiredLevels = ['L1', 'L2', 'L3', 'L4'];
    for (const level of requiredLevels) {
      if (!criteria[level] ||
        typeof criteria[level].min !== 'number' ||
        typeof criteria[level].max !== 'number') {
        return res.status(400).json({
          success: false,
          message: `Invalid criteria structure for ${level}`
        });
      }
    }

    await ensureDataDirectory();

    // Save criteria to file
    await fs.promises.writeFile(
      CRITERIA_FILE_PATH,
      JSON.stringify(criteria, null, 2),
      'utf8'
    );

    console.log('✅ Level criteria saved successfully');

    res.json({
      success: true,
      message: 'Level criteria saved successfully',
      criteria: criteria
    });
  } catch (error) {
    console.error('Error saving level criteria:', error);
    res.status(500).json({
      success: false,
      message: 'Error saving level criteria'
    });
  }
});

// Optional: Endpoint to reset criteria to default
app.post('/resetLevelCriteria', async (req, res) => {
  try {
    await ensureDataDirectory();

    await fs.promises.writeFile(
      CRITERIA_FILE_PATH,
      JSON.stringify(DEFAULT_CRITERIA, null, 2),
      'utf8'
    );

    res.json({
      success: true,
      message: 'Level criteria reset to default',
      criteria: DEFAULT_CRITERIA
    });
  } catch (error) {
    console.error('Error resetting level criteria:', error);
    res.status(500).json({
      success: false,
      message: 'Error resetting level criteria'
    });
  }
});



// Return questions for a presentation course from questions.xlsx
app.get('/presentation-questions/:folderName', (req, res) => {
  const folderName = req.params.folderName;
  const excelPath = path.join(__dirname, 'uploads', folderName, 'questions.xlsx');

  fs.access(excelPath, fs.constants.F_OK, (err) => {
    if (err) {
      console.warn('No questions.xlsx found for', folderName);
      return res.json({ questions: [] });
    }

    try {
      const wb = xlsx.readFile(excelPath);
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = xlsx.utils.sheet_to_json(sheet, { defval: "" });

      // Expecting columns: srNo, questionText, option1Text, option2Text, option3Text, option4Text, answerText
      const questions = rows
        .map((row) => ({
          srNo: row.srNo,
          questionText: row.questionText,
          option1Text: row.option1Text,
          option2Text: row.option2Text,
          option3Text: row.option3Text,
          option4Text: row.option4Text,
          answerText: row.answerText,
        }))
        .filter((q) => q.questionText && q.answerText);

      res.json({ questions });
    } catch (e) {
      console.error('Error reading questions Excel for', folderName, e);
      res.status(500).json({ error: 'Failed to read questions' });
    }
  });
});



// ============================================
// Keep your app.listen() at the very end
// ============================================


// SEGMENT_RESULT_IMPORT_V1
// Imports a Level 2/3/4 acknowledgement and course marks scanned from a
// Segment PC certificate. Existing operator/profile and Level 1 data remain
// untouched. The transaction is idempotent: rescanning updates the latest
// result instead of creating another logical completion.
app.post('/api/admin/import-segment-result', express.json(), async (req, res) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ success: false, error: 'Administrator login is required.' });
  }
  const body = req.body || {};
  const uniqueID = Number(body.uniqueID);
  const level = Number(body.level);
  const deptID = Number(body.deptID);
  const areaID = Number(body.areaID);
  const mCourseID = Number(body.mCourseID);
  const stationID = Number(body.stationID) || 0;
  const startDateText = String(body.levelStartDate || '').trim();
  const marksText = String(body.courseMarks || '').trim();
  const dateText = String(body.acknowledgementDate || '').trim();
  const dateMatch = dateText.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/) || dateText.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const acknowledgementDate = dateMatch
    ? (dateMatch[1].length === 4 ? dateMatch[1] + '-' + dateMatch[2] + '-' + dateMatch[3] : dateMatch[3] + '-' + dateMatch[2].padStart(2, '0') + '-' + dateMatch[1].padStart(2, '0'))
    : null;
  const startDateMatch = startDateText.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/) || startDateText.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const levelStartDate = startDateMatch
    ? (startDateMatch[1].length === 4 ? startDateMatch[1] + '-' + startDateMatch[2] + '-' + startDateMatch[3] : startDateMatch[3] + '-' + startDateMatch[2].padStart(2, '0') + '-' + startDateMatch[1].padStart(2, '0'))
    : acknowledgementDate;
  if (!uniqueID || ![2, 3, 4].includes(level) || !deptID || !areaID || !mCourseID || !acknowledgementDate) {
    return res.status(400).json({ success: false, error: 'The certificate is missing its operator, level, date, or hierarchy identifiers.' });
  }
  if (!/^\d+_\d+(?:_\d+_\d+)*$/.test(marksText)) {
    return res.status(400).json({ success: false, error: 'Course marks must use the CourseID_Mark format.' });
  }
  const tokens = marksText.split('_');
  const marks = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const subCourseID = Number(tokens[i]);
    const score = Number(tokens[i + 1]);
    if (!Number.isInteger(subCourseID) || subCourseID <= 0 || !Number.isFinite(score) || score < 0 || score > 100) {
      return res.status(400).json({ success: false, error: 'The certificate contains an invalid Course ID or mark.' });
    }
    if (marks.some(item => item.subCourseID === subCourseID)) {
      return res.status(400).json({ success: false, error: 'The certificate repeats Course ID ' + subCourseID + '.' });
    }
    marks.push({ subCourseID, score: Math.round(score) });
  }

  const db = connection.promise();
  try {
    await db.beginTransaction();
    const [users] = await db.query('SELECT uniqueID, name FROM users WHERE uniqueID = ? LIMIT 1 FOR UPDATE', [uniqueID]);
    if (!users.length) throw Object.assign(new Error('Unique ID ' + uniqueID + ' does not exist in the Main application.'), { statusCode: 404 });

    const [hierarchyRows] = await db.query(
      `SELECT d.deptName, a.areaName, m.mCourseName, COALESCE(s.stationName, 'Whole Line') AS stationName
       FROM departments d
       JOIN areas a ON a.areaID = ? AND a.deptID = d.deptID
       JOIN mcourses m ON m.mCourseID = ? AND m.areaID = a.areaID AND m.deptID = d.deptID
       LEFT JOIN stations s ON s.stationID = ? AND s.mCourseID = m.mCourseID
       WHERE d.deptID = ? AND (? = 0 OR s.stationID IS NOT NULL)
       LIMIT 1`,
      [areaID, mCourseID, stationID, deptID, stationID]
    );
    if (!hierarchyRows.length) throw new Error('The certificate hierarchy does not match this Main application database.');

    const courseIDs = marks.map(item => item.subCourseID);
    const [courses] = await db.query(
      `SELECT subCourseID, subCourseName, courseType, subCourseLevel, subCoursePassing,
              deptID, areaID, mCourseID, stationID
       FROM subcourses WHERE subCourseID IN (?) FOR UPDATE`,
      [courseIDs]
    );
    if (courses.length !== courseIDs.length) {
      const found = new Set(courses.map(course => Number(course.subCourseID)));
      const missing = courseIDs.filter(id => !found.has(id));
      throw new Error('Course ID(s) not found in the Main application: ' + missing.join(', ') + '.');
    }
    const expectedLevel = 'Level ' + level;
    courses.forEach(course => {
      const courseLevel = String(course.subCourseLevel || (level === 2 ? 'Level 2' : '')).trim();
      if (!(courseLevel === expectedLevel || (level === 2 && ['default', ''].includes(courseLevel)))) {
        throw new Error('Course ID ' + course.subCourseID + ' is not a ' + expectedLevel + ' course.');
      }
      const isCommon = course.mCourseID == null;
      if (!isCommon && (Number(course.deptID) !== deptID || Number(course.areaID) !== areaID || Number(course.mCourseID) !== mCourseID)) {
        throw new Error('Course ID ' + course.subCourseID + ' belongs to a different hierarchy.');
      }
      if (!isCommon && Number(course.stationID || 0) !== 0 && Number(course.stationID) !== stationID) {
        throw new Error('Course ID ' + course.subCourseID + ' belongs to a different Station.');
      }
    });

    const today = acknowledgementDate;
    for (const item of marks) {
      const course = courses.find(row => Number(row.subCourseID) === item.subCourseID);
      const passing = Number(course.subCoursePassing) || 70;
      const result = item.score >= passing ? 'Pass' : 'Fail';
      const gradeDeptID = course.mCourseID == null ? null : deptID;
      const gradeAreaID = course.mCourseID == null ? null : areaID;
      const gradeMCourseID = course.mCourseID == null ? null : mCourseID;
      if (course.courseType === 'practical') {
        const [existing] = await db.query('SELECT practicalEvalID FROM practicalevaluations WHERE uniqueID = ? AND subCourseID = ? LIMIT 1 FOR UPDATE', [uniqueID, item.subCourseID]);
        if (existing.length) {
          await db.query(`UPDATE practicalevaluations SET evaluationStatus='Submitted', finalScore=?, finalMaxScore=100,
            finalPercent=?, finalResult=?, submittedBy=?, submittedAt=? WHERE practicalEvalID=?`,
            [item.score, item.score, result, req.session.user.uniqueID || null, acknowledgementDate + ' 00:00:00', existing[0].practicalEvalID]);
        } else {
          await db.query(`INSERT INTO practicalevaluations
            (subCourseID, uniqueID, evaluationStatus, finalScore, finalMaxScore, finalPercent, finalResult, submittedBy, submittedAt)
            VALUES (?, ?, 'Submitted', ?, 100, ?, ?, ?, ?)`,
            [item.subCourseID, uniqueID, item.score, item.score, result, req.session.user.uniqueID || null, acknowledgementDate + ' 00:00:00']);
        }
      } else {
        const table = course.courseType === 'training' ? 'traininggrades' : 'coursegrades';
        const attemptColumn = course.courseType === 'training' ? 'noOfAttemptss' : 'noOfAttempts';
        const [existing] = await db.query('SELECT id FROM ' + table + ' WHERE uniqueID = ? AND subCourseID = ? ORDER BY id DESC LIMIT 1 FOR UPDATE', [uniqueID, item.subCourseID]);
        if (existing.length) {
          await db.query('UPDATE ' + table + ' SET deptID=?, areaID=?, mCourseID=?, score=?, status=?, courseDate=? WHERE id=?',
            [gradeDeptID, gradeAreaID, gradeMCourseID, item.score, result, today, existing[0].id]);
        } else {
          await db.query('INSERT INTO ' + table + ' (deptID,areaID,mCourseID,coMCourseID,subCourseID,uniqueID,' + attemptColumn + ',score,status,courseDate) VALUES (?,?,?,NULL,?,?,1,?,?,?)',
            [gradeDeptID, gradeAreaID, gradeMCourseID, item.subCourseID, uniqueID, item.score, result, today]);
        }
      }
    }

    const [enrollments] = await db.query(`SELECT enrollID FROM enrollstatus
      WHERE uniqueID=? AND deptID=? AND areaID=? AND mCourseID=? AND coMCourseID IS NULL AND subCourseID IS NULL
      ORDER BY enrollID DESC LIMIT 1 FOR UPDATE`, [uniqueID, deptID, areaID, mCourseID]);
    if (enrollments.length) {
      await db.query("UPDATE enrollstatus SET stationID=?, startDate=COALESCE(?, startDate), enrollStatus='Active', endDate=NULL WHERE enrollID=?", [stationID, level === 2 ? levelStartDate : null, enrollments[0].enrollID]);
    } else {
      await db.query(`INSERT INTO enrollstatus
        (uniqueID,deptID,areaID,mCourseID,coMCourseID,subCourseID,enrollDate,startDate,endDate,enrollStatus,stationID)
        VALUES (?,?,?,?,NULL,NULL,?,?,NULL,'Active',?)`,
        [uniqueID, deptID, areaID, mCourseID, today, level === 2 ? levelStartDate : today, stationID]);
    }

    const completionTable = 'l' + level + 'completedusers';
    const statusColumn = 'l' + level + 'Status';
    const [completed] = await db.query('SELECT id FROM ' + completionTable + ' WHERE uniqueID=? AND mCourseID=? AND stationID=? LIMIT 1 FOR UPDATE', [uniqueID, mCourseID, stationID]);
    if (completed.length) {
      await db.query('UPDATE ' + completionTable + ' SET deptID=?,areaID=?,levelStartDate=?,levelDate=?,' + statusColumn + "='Pass',acknowledgeDate=?,acknowledgedBy=? WHERE id=?",
        [deptID, areaID, levelStartDate, acknowledgementDate, acknowledgementDate + ' 00:00:00', req.session.user.uniqueID || null, completed[0].id]);
    } else {
      await db.query('INSERT INTO ' + completionTable + ' (uniqueID,deptID,areaID,mCourseID,stationID,levelStartDate,levelDate,' + statusColumn + ',acknowledgeDate,acknowledgedBy) VALUES (?,?,?,?,?,?,?,\'Pass\',?,?)',
        [uniqueID, deptID, areaID, mCourseID, stationID, levelStartDate, acknowledgementDate, acknowledgementDate + ' 00:00:00', req.session.user.uniqueID || null]);
    }

    // The Segment administrator raised this operator's required Station
    // level before training. Mirror that assignment on the Main PC so the
    // Skill Matrix shows L3/L3 or L4/L4 after the result is imported.
    await db.query(`INSERT INTO skillmatrix_station_skills
      (uniqueID,deptID,areaID,mCourseID,stationID,requiredLevel)
      VALUES (?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE requiredLevel=GREATEST(requiredLevel, VALUES(requiredLevel))`,
      [uniqueID,deptID,areaID,mCourseID,stationID,level]);

    await db.commit();
    const hierarchy = hierarchyRows[0];
    res.json({ success: true,
      message: 'Level ' + level + ' result imported successfully (' + marks.length + ' course marks).',
      user: users[0],
      assignment: { department: hierarchy.deptName, segment: hierarchy.areaName, process: hierarchy.mCourseName, station: hierarchy.stationName }
    });
  } catch (error) {
    await db.rollback().catch(() => {});
    console.error('Segment certificate result import failed:', error);
    res.status(error.statusCode || 400).json({ success: false, error: error.message || 'Segment certificate import failed.' });
  }
});


app.listen(3230, () => {
  console.log('Server is running on port 3230');
});
