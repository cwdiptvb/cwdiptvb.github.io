<script>
(function() {
  // Check if the page is inside an iframe
  const inIframe = window.self !== window.top;

  if (!inIframe) {
    // Not embedded → redirect to /admin
    window.location.replace('/admin');
  } else {
    try {
      // Embedded: check the parent origin
      const parentUrl = document.referrer;
      if (!parentUrl.startsWith('https://cwdiptvb.github.io')) {
        // If iframe parent is not from cwdiptvb.github.io → redirect
        window.location.replace('/admin');
      }
    } catch (err) {
      // If we can't check referrer, be safe and redirect
      window.location.replace('/admin');
    }
  }
})();
</script>
