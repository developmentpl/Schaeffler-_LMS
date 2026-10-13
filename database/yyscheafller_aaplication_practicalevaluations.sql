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
-- Table structure for table `practicalevaluations`
--

DROP TABLE IF EXISTS `practicalevaluations`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `practicalevaluations` (
  `practicalEvalID` int NOT NULL AUTO_INCREMENT,
  `subCourseID` int NOT NULL,
  `uniqueID` int NOT NULL,
  `employeeCode` varchar(50) DEFAULT NULL,
  `dateOfJoining` date DEFAULT NULL,
  `deptSegmentLine` varchar(255) DEFAULT NULL,
  `mcProcess` varchar(255) DEFAULT NULL,
  `ojtStartDate` date DEFAULT NULL,
  `ojtEndDate` date DEFAULT NULL,
  `evaluationStatus` varchar(20) NOT NULL DEFAULT 'Draft',
  `day10Percent` decimal(5,2) DEFAULT NULL,
  `day11Percent` decimal(5,2) DEFAULT NULL,
  `day12Percent` decimal(5,2) DEFAULT NULL,
  `day13Percent` decimal(5,2) DEFAULT NULL,
  `day14Percent` decimal(5,2) DEFAULT NULL,
  `day15Percent` decimal(5,2) DEFAULT NULL,
  `wk3Percent` decimal(5,2) DEFAULT NULL,
  `wk4Percent` decimal(5,2) DEFAULT NULL,
  `totalScore` decimal(6,2) DEFAULT NULL,
  `maxScoreApplicable` decimal(6,2) DEFAULT NULL,
  `overallPercent` decimal(5,2) DEFAULT NULL,
  `result` varchar(10) DEFAULT NULL,
  `monitoringResult` varchar(10) DEFAULT NULL,
  `submittedBy` int DEFAULT NULL,
  `submittedAt` datetime DEFAULT NULL,
  `createdAt` datetime DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `finalScore` decimal(6,2) DEFAULT NULL,
  `finalMaxScore` decimal(6,2) DEFAULT NULL,
  `finalPercent` decimal(5,2) DEFAULT NULL,
  `finalResult` varchar(10) DEFAULT 'Pending',
  PRIMARY KEY (`practicalEvalID`),
  UNIQUE KEY `uniq_practicaleval_course_user` (`subCourseID`,`uniqueID`)
) ENGINE=InnoDB AUTO_INCREMENT=8 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `practicalevaluations`
--

LOCK TABLES `practicalevaluations` WRITE;
/*!40000 ALTER TABLE `practicalevaluations` DISABLE KEYS */;
INSERT INTO `practicalevaluations` VALUES (1,4,1,'EMP012',NULL,NULL,NULL,NULL,NULL,'Submitted',50.00,83.33,100.00,100.00,93.33,83.33,70.00,73.33,196.00,240.00,81.67,'Pass','Pass',NULL,'2026-06-30 16:40:49','2026-06-30 15:33:44','2026-06-30 16:40:49',96.00,120.00,80.00,'Pass'),(6,4,2,'EMP013',NULL,NULL,NULL,NULL,NULL,'Submitted',100.00,93.33,96.67,92.86,100.00,93.33,71.43,93.33,219.00,236.00,92.80,'Pass','Pass',1,'2026-07-01 19:32:52','2026-07-01 19:32:52','2026-07-01 19:32:52',106.00,118.00,89.83,'Pass'),(7,4,3,'1','2026-07-01',NULL,NULL,NULL,NULL,'Submitted',100.00,70.00,76.67,80.00,70.00,73.33,83.33,83.33,191.00,240.00,79.58,'Pass','Pass',1,'2026-07-02 08:42:24','2026-07-02 08:42:24','2026-07-02 08:42:24',93.00,120.00,77.50,'Pass');
/*!40000 ALTER TABLE `practicalevaluations` ENABLE KEYS */;
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
