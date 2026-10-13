-- MySQL dump 10.13  Distrib 8.0.33, for Win64 (x86_64)
--
-- Host: 192.168.31.150    Database: yyscheafller_aaplication
-- ------------------------------------------------------
-- Server version	8.0.33

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!50503 SET NAMES utf8 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;

--
-- Table structure for table `refresher_subcourses`
--

DROP TABLE IF EXISTS `refresher_subcourses`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `refresher_subcourses` (
  `subCourseID` int NOT NULL AUTO_INCREMENT,
  `deptID` int DEFAULT NULL,
  `areaID` int DEFAULT NULL,
  `mCourseID` int DEFAULT NULL,
  `coMCourseID` int DEFAULT NULL,
  `subCourseName` text,
  `subCourseDescription` text,
  `subCourseDate` text,
  `subCourseTags` text,
  `subCourseTeacher` text,
  `subCourseLevel` text,
  `subCourseTeacherUniqueID` text,
  `subCoursePath` text,
  `subCourseRefreshDate` date DEFAULT NULL,
  `subCourseCompletionDate` text,
  `subCourseRevisionDate` date DEFAULT NULL,
  `subCourseRevisionNumber` varchar(100) DEFAULT NULL,
  `subCourseDocumentNo` varchar(100) DEFAULT NULL,
  `subCourseRemark` text,
  `subCourseIssueDate` date DEFAULT NULL,
  `subCourseDocAuthorised` text,
  `subCourseFormatNo` varchar(100) DEFAULT NULL,
  `practicalExam` text,
  `subCoursePassing` int DEFAULT NULL,
  `isOnlyTraining` varchar(45) DEFAULT NULL,
  `subcoursescol` varchar(45) DEFAULT NULL,
  `subCourseTeacher2` text,
  `subCourseTeacher2UniqueID` int DEFAULT NULL,
  `duration` time DEFAULT NULL,
  `courseType` enum('training','assessment','practical','ojt_observation','scorm') DEFAULT 'training',
  `contentType` enum('ppt','pdf','video','excel','scorm_zip','excel_with_ppt','video_with_excel','practical_template','observation_template') DEFAULT NULL,
  `scormPath` text,
  `scormCourseID` int DEFAULT NULL,
  `scormManifestPath` text,
  `scormVersion` varchar(45) DEFAULT NULL,
  `scormLaunchFile` text,
  `mahindraOldCourseID` int DEFAULT NULL,
  PRIMARY KEY (`subCourseID`),
  KEY `idx_refresher_subcourses_type` (`courseType`)
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `refresher_subcourses`
--

LOCK TABLES `refresher_subcourses` WRITE;
/*!40000 ALTER TABLE `refresher_subcourses` DISABLE KEYS */;
INSERT INTO `refresher_subcourses` VALUES (1,NULL,NULL,NULL,NULL,'Training Course refersher','Training Course refersher','2026-06-30',NULL,NULL,'Refresher',NULL,'uploads\\Scorm_1782819647472',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'scorm',NULL,NULL,NULL,NULL,NULL,NULL,'scorm','scorm_zip','uploads\\Scorm_1782819647472',1,NULL,NULL,NULL,1);
/*!40000 ALTER TABLE `refresher_subcourses` ENABLE KEYS */;
UNLOCK TABLES;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

-- Dump completed on 2026-07-02 12:35:33
