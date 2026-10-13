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
-- Table structure for table `comaincourses`
--

DROP TABLE IF EXISTS `comaincourses`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `comaincourses` (
  `coMCourseID` int NOT NULL AUTO_INCREMENT,
  `deptID` int DEFAULT NULL,
  `areaID` int DEFAULT NULL,
  `mCourseID` int DEFAULT NULL,
  `coMCourseName` text,
  `coMCourseDescription` text,
  `coMCourseDate` text,
  `coMCourseTags` text,
  `coMCourseTeacher` text,
  `coMCourseLevel` text,
  `coMCourseTeacherUniqueID` text,
  `coMCourseRemark` text,
  `requiredSkillLevel` varchar(45) DEFAULT NULL,
  `cpCi` varchar(45) DEFAULT NULL,
  `manPowerRequired` int DEFAULT NULL,
  `comonID` text,
  `isDefaultForLine` tinyint(1) NOT NULL DEFAULT '1',
  PRIMARY KEY (`coMCourseID`),
  KEY `idx_comain_hierarchy` (`deptID`,`areaID`,`mCourseID`),
  KEY `fk_comain_area` (`areaID`),
  KEY `fk_comain_mcourse` (`mCourseID`),
  CONSTRAINT `fk_comain_area` FOREIGN KEY (`areaID`) REFERENCES `areas` (`areaID`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_comain_dept` FOREIGN KEY (`deptID`) REFERENCES `departments` (`deptID`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_comain_mcourse` FOREIGN KEY (`mCourseID`) REFERENCES `mcourses` (`mCourseID`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `comaincourses`
--

LOCK TABLES `comaincourses` WRITE;
/*!40000 ALTER TABLE `comaincourses` DISABLE KEYS */;
INSERT INTO `comaincourses` VALUES (1,1,1,1,'MSIL Default','Default hidden group for Mahindra line/process','2026-06-27',NULL,NULL,NULL,NULL,'Hidden default group',NULL,NULL,NULL,NULL,1);
/*!40000 ALTER TABLE `comaincourses` ENABLE KEYS */;
UNLOCK TABLES;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

-- Dump completed on 2026-07-02 12:35:36
