
    document.querySelectorAll('[data-copy]').forEach(function (button) {
      button.addEventListener('click', function () {
        var value = button.getAttribute('data-copy') || '';
        var label = button.querySelector('.copy-label');
        navigator.clipboard.writeText(value).then(function () {
          if (!label) return;
          label.textContent = 'Copied';
          window.setTimeout(function () { label.textContent = 'Copy'; }, 1600);
        }).catch(function () {
          if (label) label.textContent = 'Select text';
        });
      });
    });
