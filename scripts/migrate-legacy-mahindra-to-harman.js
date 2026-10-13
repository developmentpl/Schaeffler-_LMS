const mysql = require('mysql2/promise');

const legacyConfig = {
  host: process.env.LEGACY_DB_HOST || process.env.DB_HOST || '192.168.31.150',
  port: Number(process.env.LEGACY_DB_PORT || process.env.DB_PORT || 3306),
  user: process.env.LEGACY_DB_USER || process.env.DB_USER || 'developer',
  password: process.env.LEGACY_DB_PASSWORD || process.env.DB_PASSWORD || 'Developer@123',
  database: process.env.LEGACY_DB_NAME || 'yymahindra',
};

const targetConfig = {
  host: process.env.TARGET_DB_HOST || process.env.DB_HOST || '192.168.31.150',
  port: Number(process.env.TARGET_DB_PORT || process.env.DB_PORT || 3306),
  user: process.env.TARGET_DB_USER || process.env.DB_USER || 'developer',
  password: process.env.TARGET_DB_PASSWORD || process.env.DB_PASSWORD || 'Developer@123',
  database: process.env.TARGET_DB_NAME || 'yyscheafller_aaplication',
};

function text(value) {
  if (value === undefined || value === null) return null;
  const cleaned = String(value).trim();
  return cleaned || null;
}

async function ensureDefaultArea(target, deptID) {
  const [existing] = await target.execute(
    'SELECT areaID FROM areas WHERE deptID = ? AND areaName = ? ORDER BY areaID LIMIT 1',
    [deptID, 'Default Segment']
  );
  if (existing.length) return existing[0].areaID;

  const [result] = await target.execute(
    'INSERT INTO areas (deptID, areaName, areaDescription, areaDate) VALUES (?, ?, ?, CURDATE())',
    [deptID, 'Default Segment', 'Auto-created during legacy Mahindra migration']
  );
  return result.insertId;
}

async function ensureDepartment(target, deptName, cache) {
  const name = text(deptName) || 'Default Department';
  if (cache.departments.has(name)) return cache.departments.get(name);

  const [existing] = await target.execute(
    'SELECT deptID FROM departments WHERE deptName = ? ORDER BY deptID LIMIT 1',
    [name]
  );
  if (existing.length) {
    cache.departments.set(name, existing[0].deptID);
    return existing[0].deptID;
  }

  const [result] = await target.execute(
    'INSERT INTO departments (deptName, deptDescription, deptDate) VALUES (?, ?, CURDATE())',
    [name, 'Migrated from legacy Mahindra LMS']
  );
  cache.departments.set(name, result.insertId);
  return result.insertId;
}

async function ensureProcess(target, deptID, areaID, processName, cache) {
  const name = text(processName) || 'Default Process';
  const key = `${deptID}:${areaID}:${name}`;
  if (cache.processes.has(key)) return cache.processes.get(key);

  const [existing] = await target.execute(
    'SELECT mCourseID FROM mcourses WHERE deptID = ? AND areaID = ? AND mCourseName = ? ORDER BY mCourseID LIMIT 1',
    [deptID, areaID, name]
  );
  if (existing.length) {
    cache.processes.set(key, existing[0].mCourseID);
    return existing[0].mCourseID;
  }

  const [result] = await target.execute(
    'INSERT INTO mcourses (deptID, areaID, mCourseName, mCourseDescription, mCourseDate) VALUES (?, ?, ?, ?, CURDATE())',
    [deptID, areaID, name, 'Migrated from legacy Mahindra course grouping']
  );
  cache.processes.set(key, result.insertId);
  return result.insertId;
}

async function ensureDefaultComain(target, deptID, areaID, mCourseID, processName, cache) {
  if (cache.comain.has(mCourseID)) return cache.comain.get(mCourseID);

  const [existing] = await target.execute(
    'SELECT coMCourseID FROM comaincourses WHERE mCourseID = ? AND isDefaultForLine = 1 ORDER BY coMCourseID LIMIT 1',
    [mCourseID]
  );
  if (existing.length) {
    cache.comain.set(mCourseID, existing[0].coMCourseID);
    return existing[0].coMCourseID;
  }

  const [result] = await target.execute(
    `INSERT INTO comaincourses
      (deptID, areaID, mCourseID, coMCourseName, coMCourseDescription, coMCourseDate, coMCourseRemark, isDefaultForLine)
     VALUES (?, ?, ?, ?, ?, CURDATE(), ?, 1)`,
    [deptID, areaID, mCourseID, `${processName} Default`, 'Hidden default group for Mahindra line/process', 'Hidden default group']
  );
  cache.comain.set(mCourseID, result.insertId);
  return result.insertId;
}

async function migrateUsers(legacy, target) {
  const [users] = await legacy.query('SELECT * FROM users ORDER BY id');
  let inserted = 0;

  for (const user of users) {
    const [existing] = await target.execute(
      'SELECT uniqueID FROM users WHERE mahindraOldUserID = ? OR mahindraOldUniqueID = ? ORDER BY uniqueID LIMIT 1',
      [user.id, user.uniqueID]
    );
    if (existing.length) continue;

    await target.execute(
      `INSERT INTO users
        (name, emailID, employeeID, uName, uPass, photo, photoPath, dateOfJoining, dateOfBirth, address, mobileNo,
         department, uRole, registerDate, registerTime, lastLoggedIn, qualification, contract, contractorName, status,
         skillLevel, mahindraOldUserID, mahindraOldUniqueID, licenseIssueDate)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        user.name,
        user.emailID,
        user.employeeID,
        user.uName,
        user.uPass,
        user.photo,
        user.photo_filename || null,
        user.dateOfJoining,
        user.dateOfBirth,
        user.address,
        user.mobileNo,
        user.department,
        user.uRole,
        user.currentDate,
        user.currentTime,
        user.lastLoggedIn,
        user.Qualification || user.qualification || null,
        user.Contract || user.contract || null,
        user.ContractorName || user.contractorName || null,
        user.status,
        user.Level || user.level || user.uLevel || null,
        user.id,
        user.uniqueID,
        user.LisenceIssueDate || null,
      ]
    );
    inserted += 1;
  }

  return inserted;
}

async function migrateCourses(legacy, target, cache) {
  const [courses] = await legacy.query('SELECT * FROM courses ORDER BY id');
  let inserted = 0;

  for (const course of courses) {
    const [existing] = await target.execute(
      'SELECT subCourseID FROM subcourses WHERE mahindraOldCourseID = ? ORDER BY subCourseID LIMIT 1',
      [course.courseID || course.id]
    );
    if (existing.length) {
      cache.courseMap.set(Number(course.courseID || course.id), existing[0].subCourseID);
      continue;
    }

    const deptID = await ensureDepartment(target, course.department, cache);
    const areaID = await ensureDefaultArea(target, deptID);
    const processName = text(course.mCourseName) || text(course.department) || 'Default Process';
    const mCourseID = await ensureProcess(target, deptID, areaID, processName, cache);
    const coMCourseID = await ensureDefaultComain(target, deptID, areaID, mCourseID, processName, cache);
    const legacyCourseID = Number(course.courseID || course.id);
    const contentType = course.scormPath && String(course.scormPath).toLowerCase().includes('scorm') ? 'scorm_zip' : null;
    const courseType = contentType === 'scorm_zip' ? 'scorm' : 'assessment';

    const [result] = await target.execute(
      `INSERT INTO subcourses
        (deptID, areaID, mCourseID, coMCourseID, subCourseName, subCourseDescription, subCourseDate,
         subCourseTeacher, subCourseLevel, subCoursePath, subCourseRefreshDate, courseType, contentType,
         scormPath, scormCourseID, mahindraOldCourseID)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        deptID,
        areaID,
        mCourseID,
        coMCourseID,
        course.courseName,
        course.courseDescription,
        course.courseDate,
        course.courseTeacher,
        course.level,
        course.scormPath,
        course.RT_Date || null,
        courseType,
        contentType,
        course.scormPath,
        legacyCourseID,
        legacyCourseID,
      ]
    );

    cache.courseMap.set(legacyCourseID, result.insertId);
    inserted += 1;
  }

  return inserted;
}

async function migrateEnrollments(legacy, target, cache) {
  const [tables] = await legacy.query("SHOW TABLES LIKE 'course\\_%'");
  const tableNames = tables.map(row => Object.values(row)[0]).filter(name => /^course_\d+$/.test(name));
  let inserted = 0;

  for (const tableName of tableNames) {
    const legacyCourseID = Number(tableName.replace('course_', ''));
    const subCourseID = cache.courseMap.get(legacyCourseID);
    if (!subCourseID) continue;

    const [subcourseRows] = await target.execute(
      'SELECT deptID, areaID, mCourseID, coMCourseID, subCourseID FROM subcourses WHERE subCourseID = ?',
      [subCourseID]
    );
    if (!subcourseRows.length) continue;
    const course = subcourseRows[0];

    const [legacyEnrollments] = await legacy.query(`SELECT DISTINCT uniqueID FROM \`${tableName}\` WHERE uniqueID IS NOT NULL`);
    for (const enrollment of legacyEnrollments) {
      const [targetUsers] = await target.execute(
        'SELECT uniqueID FROM users WHERE mahindraOldUniqueID = ? OR uniqueID = ? ORDER BY uniqueID LIMIT 1',
        [String(enrollment.uniqueID), enrollment.uniqueID]
      );
      if (!targetUsers.length) continue;

      const uniqueID = targetUsers[0].uniqueID;
      const [existing] = await target.execute(
        'SELECT enrollID FROM enrollstatus WHERE uniqueID = ? AND subCourseID = ? LIMIT 1',
        [uniqueID, subCourseID]
      );
      if (existing.length) continue;

      await target.execute(
        `INSERT INTO enrollstatus
          (uniqueID, deptID, areaID, mCourseID, coMCourseID, subCourseID, enrollDate, startDate, enrollStatus)
         VALUES (?, ?, ?, ?, ?, ?, CURDATE(), CURDATE(), 'Active')`,
        [uniqueID, course.deptID, course.areaID, course.mCourseID, course.coMCourseID, course.subCourseID]
      );
      inserted += 1;
    }
  }

  return inserted;
}

async function main() {
  const legacy = await mysql.createConnection(legacyConfig);
  const target = await mysql.createConnection(targetConfig);
  const cache = {
    departments: new Map(),
    processes: new Map(),
    comain: new Map(),
    courseMap: new Map(),
  };

  try {
    console.log(`Migrating users from ${legacyConfig.database} to ${targetConfig.database}`);
    const users = await migrateUsers(legacy, target);
    console.log(`Inserted users: ${users}`);

    console.log('Migrating courses into Harman-style hierarchy');
    const courses = await migrateCourses(legacy, target, cache);
    console.log(`Inserted subcourses: ${courses}`);

    console.log('Migrating legacy course_N enrollments into enrollstatus');
    const enrollments = await migrateEnrollments(legacy, target, cache);
    console.log(`Inserted enrollments: ${enrollments}`);
  } finally {
    await legacy.end();
    await target.end();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
