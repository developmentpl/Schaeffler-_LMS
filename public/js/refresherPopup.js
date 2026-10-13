// Employee-facing "refresher due" popup.
//
// Backed by GET /api/refresher/my-status. The endpoint checks the employee's
// highest/current certified level only. One year after that level's
// admin-issued license date, the same courses become due again.
//
// This script is entirely self-contained (injects its own modal markup and
// styles) so including it is a single <script src="/js/refresherPopup.js">
// tag on any employee-facing page - currently lmshomepage.html,
// myProfile.html and viewscorm.html. It is shown on every page load where a
// refresher is due (not dismissed-forever), since an overdue refresher
// should keep resurfacing until it's actually completed.
(function () {
  function buildCourseUrl(course) {
    const courseID = encodeURIComponent(course.subCourseID);
    const courseName = encodeURIComponent(course.courseName || '');
    if (course.courseType === 'training') {
      return `/trainingMaterialView.html?courseID=${courseID}`;
    }
    const scorm = encodeURIComponent(course.scormPath || '');
    return `/scormview.html?scorm=${scorm}&courseID=${courseID}&courseName=${courseName}`;
  }

  function injectStyles() {
    if (document.getElementById('refresherPopupStyles')) return;
    const style = document.createElement('style');
    style.id = 'refresherPopupStyles';
    style.textContent = `
      #refresherPopupOverlay {
        position: fixed; inset: 0; background: rgba(23, 32, 51, 0.55);
        display: flex; align-items: center; justify-content: center;
        z-index: 9999;
      }
      #refresherPopupBox {
        background: #fff; border-radius: 10px; max-width: 480px; width: 92%;
        max-height: 82vh; overflow-y: auto; padding: 24px 26px;
        box-shadow: 0 12px 40px rgba(0,0,0,0.25); font-family: inherit;
      }
      #refresherPopupBox h2 { margin: 0 0 8px; font-size: 20px; color: #172033; }
      #refresherPopupBox p.rp-sub { margin: 0 0 16px; color: #55607a; font-size: 14px; line-height: 1.4; }
      .rp-course-list { list-style: none; margin: 0 0 18px; padding: 0; }
      .rp-course-item {
        display: flex; align-items: center; justify-content: space-between;
        padding: 10px 12px; border: 1px solid #e3e6ec; border-radius: 8px;
        margin-bottom: 8px;
      }
      .rp-course-name { font-size: 14px; color: #172033; padding-right: 10px; }
      .rp-course-level { font-size: 11px; color: #6b7a90; font-weight: 600; margin-right: 6px; }
      .rp-course-badge {
        font-size: 11px; font-weight: 600; padding: 3px 8px; border-radius: 12px;
        white-space: nowrap;
      }
      .rp-badge-pending { background: #fdecea; color: #b3261e; }
      .rp-badge-done { background: #e6f4ea; color: #1e7e34; }
      .rp-course-btn {
        font-size: 12px; padding: 5px 10px; border-radius: 6px; border: none;
        background: #172033; color: #fff; text-decoration: none; margin-left: 8px;
        display: inline-block;
      }
      .rp-badge-locked { background: #fff3cd; color: #8a6400; }
      .rp-locked-note { font-size: 11px; color: #8a6400; margin-left: 8px; }
      #refresherPopupCloseBtn {
        display: block; width: 100%; padding: 10px; border: none; border-radius: 8px;
        background: #eef0f4; color: #172033; font-weight: 600; cursor: pointer;
      }
    `;
    document.head.appendChild(style);
  }

  function renderPopup(data) {
    injectStyles();
    if (document.getElementById('refresherPopupOverlay')) return;

    const overlay = document.createElement('div');
    overlay.id = 'refresherPopupOverlay';

    const box = document.createElement('div');
    box.id = 'refresherPopupBox';

    box.innerHTML =
      '<h2>Refresher Enabled</h2>' +
      '<p class="rp-sub">Your ' + (data.levelLabel || 'current level') +
      ' refresher is enabled. Please open My Courses and complete the assigned level courses again.</p>' +
      '<a class="rp-course-btn" style="display:block;text-align:center;margin:0 0 10px;padding:10px;" href="/viewscorm.html">Go to My Courses</a>' +
      '<button id="refresherPopupCloseBtn" type="button">Remind me later</button>';

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    box.querySelector('#refresherPopupCloseBtn').addEventListener('click', function () {
      overlay.remove();
    });
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) overlay.remove();
    });
  }

  function checkRefresherStatus() {
    if (sessionStorage.getItem('refresherNoticeShown') === '1') return;
    fetch('/api/refresher/my-status')
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data || !data.success || !data.applicable || !data.due || data.awaitingCertification) return;
        sessionStorage.setItem('refresherNoticeShown', '1');
        renderPopup(data);
      })
      .catch(function (err) { console.warn('Refresher status check failed (non-fatal):', err); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', checkRefresherStatus);
  } else {
    checkRefresherStatus();
  }
})();
